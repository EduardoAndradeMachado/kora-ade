package br.com.eduardom.kora

import java.io.ByteArrayInputStream
import java.io.File
import java.io.InputStream
import java.net.Socket
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
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.BeforeClass
import org.junit.Rule
import org.junit.Test
import org.junit.rules.Timeout

/**
 * A passagem local do app contra o relay e o PC de verdade (test/fixtures/pc-remoto.ts): a tela fala HTTP comum com
 * 127.0.0.1 e cada conexão segue cifrada até o PC. Sem o cookie secreto, quem bate na porta não passa.
 */
class PassagemTest {
    @get:Rule val prazo: Timeout = Timeout.seconds(30)

    companion object {
        private var processo: Process? = null
        private lateinit var dados: JSONObject
        private lateinit var passagem: Passagem
        private val cliente = OkHttpClient.Builder().readTimeout(0, TimeUnit.MILLISECONDS).build()

        @BeforeClass @JvmStatic
        fun subir() {
            val raiz = generateSequence(File("").absoluteFile) { it.parentFile }.first { File(it, "relay/relay.ts").exists() }
            assumeTrue("o teste precisa do Node", runCatching { ProcessBuilder("node", "--version").start().waitFor() == 0 }.getOrDefault(false))
            val iniciado = ProcessBuilder("node", "test/fixtures/pc-remoto.ts").directory(raiz).redirectError(ProcessBuilder.Redirect.INHERIT).start()
            processo = iniciado
            dados = JSONObject(iniciado.inputStream.bufferedReader().readLine() ?: error("o PC de teste não subiu"))
            val identidade = dados.getJSONObject("celular")
            val pem = { texto: String -> Base64.getMimeDecoder().decode(texto.lines().filter { !it.startsWith("-----") }.joinToString("")) }
            val chave = ChaveDoCelular(
                KeyFactory.getInstance("EC").generatePrivate(PKCS8EncodedKeySpec(pem(identidade.getString("key")))),
                CertificateFactory.getInstance("X.509").generateCertificate(ByteArrayInputStream(identidade.getString("cert").toByteArray())) as X509Certificate
            )
            val pc = dados.getString("pc")
            passagem = Passagem { Envelope.abrir(cliente, "ws://127.0.0.1:${dados.getInt("porta")}/c/$pc", contextoDoEnvelope(chave, pc), 10_000) }.iniciar()
        }

        @AfterClass @JvmStatic
        fun derrubar() {
            if (::passagem.isInitialized) passagem.close()
            processo?.outputStream?.close()
            processo?.waitFor(5, TimeUnit.SECONDS)
            processo?.destroy()
        }

        private class Resposta(val status: Int, val cabecalhos: String, val corpo: String)

        // Uma resposta HTTP/1.1 com Content-Length ou fechada no fim; lida do fluxo sem fechar a conexão.
        private fun lerResposta(entrada: InputStream): Resposta {
            val cabecalho = String(Passagem.lerCabecalho(entrada) ?: error("conexão fechou sem resposta"), Charsets.ISO_8859_1)
            val status = cabecalho.substringAfter(' ').substringBefore(' ').toInt()
            val tamanho = Regex("(?i)content-length: *(\\d+)").find(cabecalho)?.groupValues?.get(1)?.toInt()
            val corpo = if (tamanho != null) ByteArray(tamanho).also { var lido = 0; while (lido < tamanho) lido += entrada.read(it, lido, tamanho - lido) } else entrada.readBytes()
            return Resposta(status, cabecalho, corpo.decodeToString())
        }

        private fun pedir(vararg pedidos: String): List<Resposta> = Socket("127.0.0.1", passagem.porta).use { socket ->
            pedidos.map { pedido ->
                socket.getOutputStream().write(pedido.toByteArray())
                lerResposta(socket.getInputStream())
            }
        }

        private val cookie get() = "Cookie: kora-passagem=${passagem.segredo}\r\n"
    }

    @Test
    fun outroAppSemOCookieNaoPassa() {
        assertEquals(403, pedir("GET /eco HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").single().status)
        assertEquals(403, pedir("GET /eco HTTP/1.1\r\nHost: 127.0.0.1\r\nCookie: kora-passagem=chute\r\n\r\n").single().status)
        assertEquals(403, pedir("GET /?k=chute HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").single().status)
    }

    @Test
    fun aTelaRecebeOCookieAoAbrirOEnderecoDeInicio() {
        val resposta = pedir("GET /?k=${passagem.segredo} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").single()
        assertEquals(302, resposta.status)
        assertTrue(resposta.cabecalhos, resposta.cabecalhos.contains("Set-Cookie: kora-passagem=${passagem.segredo}; Path=/; HttpOnly; SameSite=Strict"))
    }

    @Test
    fun oInicioPodeLevarATelaDiretoAoPareamentoMasNuncaParaForaDaPassagem() {
        val pareamento = pedir("GET /?k=${passagem.segredo}&ir=%2F%23pair%3Dabc HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").single()
        assertTrue(pareamento.cabecalhos, pareamento.cabecalhos.contains("Location: /#pair=abc\r\n"))
        for (fora in listOf("%2F%2Fexemplo.com", "https%3A%2F%2Fexemplo.com", "%2F%0D%0ASet-Cookie%3A+x%3Dy")) {
            val resposta = pedir("GET /?k=${passagem.segredo}&ir=$fora HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").single()
            assertTrue(resposta.cabecalhos, resposta.cabecalhos.contains("Location: /\r\n"))
        }
    }

    @Test
    fun comOCookieOsPedidosChegamAoPcPeloRelayInclusiveVariosNaMesmaConexao() {
        val corpo = "mensagem do celular"
        val respostas = pedir(
            "GET /eco HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Quem: a passagem\r\n$cookie\r\n",
            "POST /corpo HTTP/1.1\r\nHost: 127.0.0.1\r\n${cookie}Content-Length: ${corpo.length}\r\n\r\n$corpo",
            "GET /cabecalhos HTTP/1.1\r\nHost: 127.0.0.1:${passagem.porta}\r\n$cookie\r\n"
        )
        assertEquals(listOf(200, 200, 200), respostas.map { it.status })
        assertEquals("eco do PC para a passagem", respostas[0].corpo)
        assertEquals("recebi: $corpo", respostas[1].corpo)
        // O PC recebe o Host da tela (127.0.0.1:porta), que é a origem que ela usa nos pedidos.
        assertEquals("127.0.0.1:${passagem.porta}", JSONObject(respostas[2].corpo).getString("host"))
    }

    @Test
    fun oLinkDeArquivoDoProjetoPassaSemOCookieDaTela() {
        // O HTML aberto no navegador (Abrir página inteira) não tem o cookie; o /raw/ chega ao PC, que confere a chave.
        val resposta = pedir("GET /raw/chave/pagina.html HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n").single()
        assertEquals(404, resposta.status)
    }

    @Test
    fun falhaQueNaoEDeRedeAoAbrirViraErroParaATelaENaoDerrubaOApp() {
        val quebrada = Passagem { throw IllegalStateException("Keystore indisponível") }.iniciar()
        try {
            repeat(2) {
                Socket("127.0.0.1", quebrada.porta).use { socket ->
                    socket.getOutputStream().write("GET /eco HTTP/1.1\r\nHost: 127.0.0.1\r\nCookie: ${quebrada.cookie}\r\n\r\n".toByteArray())
                    assertEquals(502, lerResposta(socket.getInputStream()).status)
                }
            }
        } finally {
            quebrada.close()
        }
    }
}
