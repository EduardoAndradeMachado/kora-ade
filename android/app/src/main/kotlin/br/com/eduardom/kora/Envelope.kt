package br.com.eduardom.kora

import java.io.Closeable
import java.io.EOFException
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.Socket
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.security.Principal
import java.security.PrivateKey
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLEngine
import javax.net.ssl.SSLEngineResult.HandshakeStatus
import javax.net.ssl.SSLEngineResult.Status
import javax.net.ssl.X509ExtendedKeyManager
import javax.net.ssl.X509TrustManager
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString

/** O ID de um aparelho: a impressão digital SHA-256 do certificado, como o Kora do PC calcula (src/main/remote/identity.ts). */
fun impressaoDigital(certificado: X509Certificate): String =
    MessageDigest.getInstance("SHA-256").digest(certificado.encoded).joinToString("") { "%02x".format(it) }

/** A chave deste celular (no Keystore, no app; de um arquivo, nos testes) apresentada ao PC no aperto de mãos. */
class ChaveDoCelular(private val chave: PrivateKey, private val certificado: X509Certificate) : X509ExtendedKeyManager() {
    override fun chooseClientAlias(keyType: Array<String>?, issuers: Array<Principal>?, socket: Socket?) = ALIAS
    override fun chooseEngineClientAlias(keyType: Array<String>?, issuers: Array<Principal>?, engine: SSLEngine?) = ALIAS
    override fun getCertificateChain(alias: String?) = arrayOf(certificado)
    override fun getPrivateKey(alias: String?) = chave
    override fun getClientAliases(keyType: String?, issuers: Array<Principal>?) = arrayOf(ALIAS)
    override fun getServerAliases(keyType: String?, issuers: Array<Principal>?) = null
    override fun chooseServerAlias(keyType: String?, issuers: Array<Principal>?, socket: Socket?) = null

    private companion object { const val ALIAS = "celular" }
}

/**
 * Só aceita o PC cujo certificado veio no QR. A conferência acontece dentro do aperto de mãos: com outro certificado ele
 * falha antes de qualquer dado sair do celular. Cadeia e validade não importam; a confiança vem do pareamento.
 */
class SoOPcPareado(private val esperado: String) : X509TrustManager {
    override fun checkServerTrusted(chain: Array<X509Certificate>?, authType: String?) {
        val certificado = chain?.firstOrNull() ?: throw CertificateException("O PC não apresentou certificado.")
        if (impressaoDigital(certificado) != esperado) throw CertificateException("O certificado do PC não é o do pareamento.")
    }
    override fun checkClientTrusted(chain: Array<X509Certificate>?, authType: String?) = throw CertificateException("O celular não aceita conexões.")
    override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
}

fun contextoDoEnvelope(chave: ChaveDoCelular, pc: String): SSLContext =
    SSLContext.getInstance("TLS").apply { init(arrayOf(chave), arrayOf(SoOPcPareado(pc)), null) }

/**
 * O envelope de dentro: TLS 1.3 entre o celular e o PC, por cima de qualquer transporte de bytes (o WebSocket do relay).
 * O TLS é o SSLEngine da plataforma; aqui só se levam os bytes de um lado para o outro. Depois de [iniciar], [entrada] e
 * [saida] são o canal em claro com o PC.
 */
class Envelope(private val engine: SSLEngine, private val transporte: Transporte) : Closeable {
    interface Transporte {
        fun enviar(bytes: ByteArray): Boolean
        fun fechar()
    }

    private val trava = Any()
    // Bytes cifrados que chegaram e ainda não formaram um registro TLS inteiro; fica sempre em modo de leitura.
    private var recebido: ByteBuffer = ByteBuffer.allocate(engine.session.packetBufferSize).apply { flip() }
    private val claro = LinkedBlockingQueue<ByteArray>()
    private val pronto = CountDownLatch(1)
    @Volatile private var falha: IOException? = null
    @Volatile private var estaPronto = false

    val entrada: InputStream = object : InputStream() {
        private var atual = ByteArray(0)
        private var posicao = 0
        override fun read(): Int {
            val um = ByteArray(1)
            return if (read(um, 0, 1) < 0) -1 else um[0].toInt() and 0xff
        }
        override fun read(destino: ByteArray, inicio: Int, tamanho: Int): Int {
            if (tamanho == 0) return 0
            while (posicao >= atual.size) {
                val proximo = claro.take()
                if (proximo === FIM) {
                    claro.put(FIM)
                    return -1
                }
                atual = proximo
                posicao = 0
            }
            val n = minOf(tamanho, atual.size - posicao)
            System.arraycopy(atual, posicao, destino, inicio, n)
            posicao += n
            return n
        }
        override fun close() = this@Envelope.close()
    }

    val saida: OutputStream = object : OutputStream() {
        override fun write(b: Int) = write(byteArrayOf(b.toByte()), 0, 1)
        override fun write(origem: ByteArray, inicio: Int, tamanho: Int) {
            esperarPronto(PRAZO_ESCRITA_MS)
            synchronized(trava) { cifrar(ByteBuffer.wrap(origem, inicio, tamanho)) }
        }
        override fun close() = this@Envelope.close()
    }

    /** Faz o aperto de mãos. Lança se o PC não for o do pareamento, se recusar este celular ou se o prazo acabar. */
    fun iniciar(prazoMs: Long) {
        engine.useClientMode = true
        engine.enabledProtocols = arrayOf("TLSv1.3")
        executar { engine.beginHandshake(); avancar() }
        esperarPronto(prazoMs)
    }

    /** Chamado pelo transporte a cada pedaço cifrado que chega. */
    fun recebeu(bytes: ByteArray) = executar {
        recebido.compact()
        if (recebido.remaining() < bytes.size) {
            recebido.flip()
            recebido = ByteBuffer.allocate(recebido.remaining() + bytes.size + engine.session.packetBufferSize).put(recebido)
        }
        recebido.put(bytes)
        recebido.flip()
        avancar()
    }

    fun transporteFechou(motivo: String) = falhar(EOFException(motivo))

    override fun close() {
        runCatching {
            synchronized(trava) {
                engine.closeOutbound()
                cifrar(ByteBuffer.allocate(0))
            }
        }
        falhar(EOFException("Conexão encerrada."))
    }

    private fun esperarPronto(prazoMs: Long) {
        if (!pronto.await(prazoMs, TimeUnit.MILLISECONDS)) {
            falhar(IOException("O aperto de mãos com o PC não terminou a tempo."))
        }
        falha?.let { throw it }
    }

    private fun executar(passo: () -> Unit) {
        try {
            synchronized(trava) { passo() }
        } catch (erro: Exception) {
            falhar(if (erro is IOException) erro else IOException(erro.message, erro))
        }
    }

    // Leva o TLS adiante até ele precisar de bytes que ainda não chegaram.
    private fun avancar() {
        while (true) {
            when (engine.handshakeStatus) {
                HandshakeStatus.NEED_WRAP -> cifrar(ByteBuffer.allocate(0))
                HandshakeStatus.NEED_TASK -> while (true) { (engine.delegatedTask ?: break).run() }
                HandshakeStatus.NEED_UNWRAP -> if (!decifrar()) return
                else -> {
                    if (!estaPronto) {
                        estaPronto = true
                        pronto.countDown()
                    }
                    if (!decifrar()) return
                }
            }
        }
    }

    private fun decifrar(): Boolean {
        if (!recebido.hasRemaining()) return false
        val destino = ByteBuffer.allocate(engine.session.applicationBufferSize)
        val resultado = engine.unwrap(recebido, destino)
        when (resultado.status) {
            Status.BUFFER_UNDERFLOW -> return false
            Status.CLOSED -> {
                falhar(EOFException("O PC encerrou a conexão."))
                return false
            }
            else -> {
                destino.flip()
                if (destino.hasRemaining()) claro.put(ByteArray(destino.remaining()).also { destino.get(it) })
                return resultado.bytesConsumed() > 0 || resultado.bytesProduced() > 0
            }
        }
    }

    private fun cifrar(origem: ByteBuffer) {
        do {
            val destino = ByteBuffer.allocate(engine.session.packetBufferSize)
            val resultado = engine.wrap(origem, destino)
            destino.flip()
            if (destino.hasRemaining() && !transporte.enviar(ByteArray(destino.remaining()).also { destino.get(it) })) {
                throw IOException("A conexão com o relay caiu.")
            }
            if (resultado.status == Status.CLOSED) return
            if (resultado.handshakeStatus == HandshakeStatus.NEED_TASK) while (true) { (engine.delegatedTask ?: break).run() }
        } while (origem.hasRemaining())
    }

    private fun falhar(erro: IOException) {
        if (falha == null) falha = erro
        claro.put(FIM)
        pronto.countDown()
        transporte.fechar()
    }

    companion object {
        private val FIM = ByteArray(0)
        private const val PRAZO_ESCRITA_MS = 15_000L

        /** Abre o WebSocket até o relay e, por dentro dele, o envelope com o PC. */
        fun abrir(cliente: OkHttpClient, url: String, contexto: SSLContext, prazoMs: Long): Envelope {
            val socket = AtomicReference<WebSocket>()
            val envelope = Envelope(contexto.createSSLEngine(), object : Transporte {
                override fun enviar(bytes: ByteArray) = socket.get()?.send(bytes.toByteString()) ?: false
                override fun fechar() { socket.get()?.cancel() }
            })
            val aberto = CountDownLatch(1)
            socket.set(cliente.newWebSocket(Request.Builder().url(url).build(), object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) = aberto.countDown()
                override fun onMessage(webSocket: WebSocket, bytes: ByteString) = envelope.recebeu(bytes.toByteArray())
                // O relay fecha quando a outra ponta sai; o OkHttp só chama onClosed depois de o app responder ao fechamento.
                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    webSocket.close(1000, null)
                    envelope.transporteFechou("O relay fechou a conexão.")
                }
                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = envelope.transporteFechou("O relay fechou a conexão.")
                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    envelope.transporteFechou(if (response != null) "O relay recusou a conexão." else "Não foi possível chegar ao relay.")
                    aberto.countDown()
                }
            }))
            if (!aberto.await(prazoMs, TimeUnit.MILLISECONDS)) {
                envelope.close()
                throw IOException("O relay não respondeu a tempo.")
            }
            envelope.iniciar(prazoMs)
            return envelope
        }
    }
}
