package br.com.eduardom.kora

import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.Closeable
import java.io.IOException
import java.io.InputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap
import kotlin.concurrent.thread

/**
 * Passagem local para o PC pelo relay. Fora de casa a tela do Kora (a mesma página de sempre, no WebView) fala com
 * http://127.0.0.1:<porta>, e cada conexão dela segue por um envelope cifrado até o PC ([abrir]). A página não muda nada:
 * envios, imagens, áudio e o fluxo de eventos passam como passavam pela rede local.
 *
 * Outros apps do celular também alcançam 127.0.0.1. Por isso a passagem só atende quem traz o cookie secreto, que a tela
 * recebe ao abrir [inicio] e que o WebView não entrega a ninguém (HttpOnly, só deste endereço).
 */
class Passagem(private val abrir: () -> Envelope) : Closeable {
    val segredo: String = ByteArray(32).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }
    private val servidor = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
    private val conexoes = ConcurrentHashMap.newKeySet<Socket>()
    @Volatile private var fechada = false

    val porta: Int get() = servidor.localPort
    val inicio: String get() = "http://127.0.0.1:$porta/?k=$segredo"

    fun iniciar(): Passagem {
        thread(isDaemon = true, name = "passagem") {
            while (!fechada) {
                val cliente = runCatching { servidor.accept() }.getOrNull() ?: break
                conexoes += cliente
                thread(isDaemon = true, name = "passagem-conexao") { atender(cliente) }
            }
        }
        return this
    }

    override fun close() {
        fechada = true
        runCatching { servidor.close() }
        for (conexao in conexoes) runCatching { conexao.close() }
        conexoes.clear()
    }

    private fun atender(cliente: Socket) {
        try {
            val entrada = BufferedInputStream(cliente.getInputStream())
            val cabecalho = lerCabecalho(entrada) ?: return
            val texto = String(cabecalho, Charsets.ISO_8859_1)
            val alvo = texto.substringBefore("\r\n").split(' ').getOrNull(1) ?: return
            if (alvo == "/?k=$segredo") {
                return responder(cliente, "302 Found", "Location: /\r\nSet-Cookie: $COOKIE=$segredo; Path=/; HttpOnly; SameSite=Strict\r\n")
            }
            if (!cookieCerto(texto)) return responder(cliente, "403 Forbidden", "")
            val envelope = try { abrir() } catch (erro: IOException) {
                return responder(cliente, "502 Bad Gateway", "X-Kora-Erro: ${erro.message.orEmpty().replace(Regex("[\\r\\n]"), " ")}\r\n")
            }
            envelope.use {
                envelope.saida.write(cabecalho)
                // Daqui em diante só se levam bytes: os pedidos seguintes da mesma conexão vão direto, já conferidos.
                thread(isDaemon = true, name = "passagem-ida") {
                    runCatching { entrada.copyTo(envelope.saida) }
                    envelope.close()
                }
                runCatching { envelope.entrada.copyTo(cliente.getOutputStream()) }
            }
        } catch (_: IOException) {
        } finally {
            runCatching { cliente.close() }
            conexoes -= cliente
        }
    }

    private fun cookieCerto(cabecalho: String): Boolean = cabecalho.split("\r\n")
        .filter { it.startsWith("cookie:", ignoreCase = true) }
        .flatMap { it.substringAfter(':').split(';') }
        .any { it.trim() == "$COOKIE=$segredo" }

    private fun responder(cliente: Socket, status: String, extras: String) {
        cliente.getOutputStream().write("HTTP/1.1 $status\r\n${extras}Content-Length: 0\r\nConnection: close\r\n\r\n".toByteArray(Charsets.ISO_8859_1))
    }

    companion object {
        private const val COOKIE = "kora-passagem"
        private const val MAX_CABECALHO = 64 * 1024

        /** O cabeçalho do primeiro pedido, até a linha em branco; null se a conexão fechar antes ou ele for grande demais. */
        fun lerCabecalho(entrada: InputStream): ByteArray? {
            val lido = ByteArrayOutputStream()
            var fim = 0
            while (lido.size() < MAX_CABECALHO) {
                val byte = entrada.read()
                if (byte < 0) return null
                lido.write(byte)
                fim = if (byte == FIM[fim].toInt()) fim + 1 else if (byte == FIM[0].toInt()) 1 else 0
                if (fim == FIM.size) return lido.toByteArray()
            }
            return null
        }

        private val FIM = "\r\n\r\n".toByteArray()
    }
}
