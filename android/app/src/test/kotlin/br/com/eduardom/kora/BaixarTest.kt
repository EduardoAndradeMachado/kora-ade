package br.com.eduardom.kora

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class BaixarTest {
    @Test
    fun oLinkDeLeituraDoKoraAbertoPassaPelaRedeDeCasaEPelaPassagem() {
        assertNotNull(enderecoParaBaixar("http://192.168.0.7:43127/raw/tok/docs/simulado%20final.html", "192.168.0.7", 43127))
        assertNotNull(enderecoParaBaixar("http://127.0.0.1:43190/raw/tok/doc.pdf", "127.0.0.1", 43190))
    }

    @Test
    fun outroEnderecoNaoVaiParaODownloadDoApp() {
        // Outro PC, outra porta (outro app do celular no 127.0.0.1), a API do Kora e endereços da internet.
        assertNull(enderecoParaBaixar("http://192.168.0.8:43127/raw/tok/a.html", "192.168.0.7", 43127))
        assertNull(enderecoParaBaixar("http://127.0.0.1:8080/raw/tok/a.html", "127.0.0.1", 43190))
        assertNull(enderecoParaBaixar("http://127.0.0.1:43190/api/state", "127.0.0.1", 43190))
        assertNull(enderecoParaBaixar("https://exemplo.com/raw/tok/a.html", "exemplo.com", 443))
        assertNull(enderecoParaBaixar("http://x@127.0.0.1:43190/raw/tok/a.html", "127.0.0.1", 43190))
        assertNull(enderecoParaBaixar("http://127.0.0.1:43190/raw/tok/a.html?k=1", "127.0.0.1", 43190))
        assertNull(enderecoParaBaixar("não é endereço", "127.0.0.1", 43190))
    }

    @Test
    fun oNomeSalvoNaoSaiDaPastaNemFicaOculto() {
        assertEquals("simulado.html", nomeParaSalvar("simulado.html"))
        assertEquals("passwd", nomeParaSalvar("../../etc/passwd"))
        assertEquals("env", nomeParaSalvar("..\\.env"))
        assertEquals("ab.pdf", nomeParaSalvar("a\u0000b.pdf"))
        assertEquals("arquivo", nomeParaSalvar(" / "))
        // Comprido demais: corta o nome e guarda a extensão, sem partir um emoji no meio.
        val longo = nomeParaSalvar("a".repeat(118) + "😀😀😀.html")
        assertEquals("a".repeat(115) + ".html", longo)
        val emoji = nomeParaSalvar("😀".repeat(130) + ".pdf")
        assertEquals("😀".repeat(116) + ".pdf", emoji)
    }

    @Test
    fun aChaveDaPonteVaiSoParaATelaDoKoraNuncaParaOHtmlDoProjeto() {
        assertTrue(recebeAChave("http://192.168.0.7:43127/"))
        assertTrue(recebeAChave("http://127.0.0.1:43190/?convite=1#pair=123"))
        assertFalse(recebeAChave("http://127.0.0.1:43190/raw/tok/simulado.html"))
        assertFalse(recebeAChave("http://192.168.0.7:43127/raw/tok/docs/a.html"))
        assertFalse(recebeAChave(null))
        assertFalse(recebeAChave("não é endereço"))
    }

    @Test
    fun oTipoVemDoPcSemCharset() {
        assertEquals("text/html", tipoDoArquivo("text/html; charset=utf-8"))
        assertEquals("application/pdf", tipoDoArquivo("application/pdf"))
        assertEquals("application/octet-stream", tipoDoArquivo(null))
        assertEquals("application/octet-stream", tipoDoArquivo("lixo"))
    }
}
