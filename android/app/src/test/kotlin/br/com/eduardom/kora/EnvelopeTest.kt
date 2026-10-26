package br.com.eduardom.kora

import java.io.ByteArrayInputStream
import java.io.File
import java.io.IOException
import java.security.KeyFactory
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.security.spec.PKCS8EncodedKeySpec
import java.util.Base64
import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient
import org.json.JSONObject
import org.junit.AfterClass
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Assume.assumeTrue
import org.junit.BeforeClass
import org.junit.Rule
import org.junit.Test
import org.junit.rules.Timeout

/**
 * O envelope do app contra o relay e o PC de verdade do Kora (test/fixtures/pc-remoto.ts, que usa o mesmo código do PC).
 * Prova que o TLS do Android e o do Node se entendem pelo relay, e que cada lado recusa quem não é do pareamento.
 */
class EnvelopeTest {
    // Uma conexão que não fecha deixaria o teste parado para sempre: aqui ela vira falha.
    @get:Rule val prazo: Timeout = Timeout.seconds(30)

    companion object {
        private var processo: Process? = null
        private lateinit var dados: JSONObject
        private val cliente = OkHttpClient.Builder().readTimeout(0, TimeUnit.MILLISECONDS).build()

        @BeforeClass @JvmStatic
        fun subirPc() {
            val raiz = generateSequence(File("").absoluteFile) { it.parentFile }.first { File(it, "relay/relay.ts").exists() }
            val node = runCatching { ProcessBuilder("node", "--version").start().waitFor() == 0 }.getOrDefault(false)
            assumeTrue("o teste precisa do Node para subir o relay e o PC", node)
            val iniciado = ProcessBuilder("node", "test/fixtures/pc-remoto.ts").directory(raiz).redirectError(ProcessBuilder.Redirect.INHERIT).start()
            processo = iniciado
            dados = JSONObject(iniciado.inputStream.bufferedReader().readLine() ?: error("o PC de teste não subiu"))
        }

        @AfterClass @JvmStatic
        fun derrubarPc() {
            processo?.outputStream?.close()
            processo?.waitFor(5, TimeUnit.SECONDS)
            processo?.destroy()
        }

        private fun pem(texto: String) = Base64.getMimeDecoder().decode(texto.lines().filter { !it.startsWith("-----") }.joinToString(""))

        private fun chave(nome: String): ChaveDoCelular {
            val identidade = dados.getJSONObject(nome)
            val privada = KeyFactory.getInstance("EC").generatePrivate(PKCS8EncodedKeySpec(pem(identidade.getString("key"))))
            val certificado = CertificateFactory.getInstance("X.509").generateCertificate(ByteArrayInputStream(identidade.getString("cert").toByteArray())) as X509Certificate
            return ChaveDoCelular(privada, certificado)
        }

        private fun url(pc: String) = "ws://127.0.0.1:${dados.getInt("porta")}/c/$pc"

        // A prova da chave que o relay exige, montada pelo código do app e conferida pelo relay de verdade (Node).
        private fun assinado(nome: String, pc: String, caminho: String = "/c/$pc") = cabecalhosDoRelay(chave(nome), caminho, "android/teste kora-android/teste")

        private fun pedir(envelope: Envelope): String {
            envelope.saida.write("GET /eco HTTP/1.1\r\nHost: kora\r\nX-Quem: celular\r\nConnection: close\r\n\r\n".toByteArray())
            envelope.saida.flush()
            return envelope.entrada.readBytes().decodeToString()
        }
    }

    @Test
    fun oCelularPareadoFalaComOPcPeloRelay() {
        val pc = dados.getString("pc")
        val envelope = Envelope.abrir(cliente, url(pc), contextoDoEnvelope(chave("celular"), pc), 10_000, assinado("celular", pc))
        val resposta = pedir(envelope)
        assertTrue(resposta, resposta.startsWith("HTTP/1.1 200"))
        assertTrue(resposta, resposta.endsWith("eco do PC para celular"))
    }

    @Test
    fun oCelularRecusaUmPcQueNaoEOdoQrAntesDeMandarQualquerCoisa() {
        val pc = dados.getString("pc")
        // O app espera outro PC (outra impressão digital), mas o relay entrega o PC que está lá.
        val outro = pc.reversed()
        try {
            Envelope.abrir(cliente, url(pc), contextoDoEnvelope(chave("celular"), outro), 10_000, assinado("celular", pc))
            fail("o envelope abriu com um PC que não é o do pareamento")
        } catch (erro: IOException) {
            assertTrue(erro.toString(), generateSequence<Throwable>(erro) { it.cause }.any { it.message?.contains("não é o do pareamento") == true })
        }
    }

    @Test
    fun oPcRecusaUmCelularQueNaoFoiPareado() {
        val pc = dados.getString("pc")
        val resposta = runCatching { pedir(Envelope.abrir(cliente, url(pc), contextoDoEnvelope(chave("estranho"), pc), 10_000, assinado("estranho", pc))) }
        // No TLS 1.3 o celular termina o aperto de mãos antes de o PC conferir o certificado dele: a recusa chega logo
        // depois, como erro ou conexão fechada, e o pedido nunca é atendido.
        assertFalse(resposta.toString(), resposta.getOrNull()?.contains("eco do PC") == true)
    }

    @Test
    fun oRelayRecusaQuemNaoProvaAChaveOuAssinaOutroCaminho() {
        val pc = dados.getString("pc")
        for (cabecalhos in listOf(emptyMap(), assinado("celular", pc, "/c/${pc.reversed()}"))) {
            try {
                pedir(Envelope.abrir(cliente, url(pc), contextoDoEnvelope(chave("celular"), pc), 10_000, cabecalhos))
                fail("o relay deixou passar sem a prova da chave")
            } catch (erro: IOException) {
                assertTrue(erro.toString(), generateSequence<Throwable>(erro) { it.cause }.any { it.message?.contains("relay") == true })
            }
        }
    }

    @Test
    fun oIdDoCelularEaImpressaoDigitalQueOPcConfere() {
        val identidade = dados.getJSONObject("celular")
        val certificado = CertificateFactory.getInstance("X.509").generateCertificate(ByteArrayInputStream(identidade.getString("cert").toByteArray())) as X509Certificate
        assertEquals(identidade.getString("fingerprint"), impressaoDigital(certificado))
    }
}
