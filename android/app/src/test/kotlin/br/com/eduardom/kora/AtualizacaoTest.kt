package br.com.eduardom.kora

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AtualizacaoTest {
    @Test
    fun ofereceSoVersaoMaisNovaQueAInstalada() {
        val json = """{"versionCode":5,"versionName":"0.3.0"}"""
        assertEquals(VersaoDoApp(5, "0.3.0"), versaoMaisNova(json, 4))
        assertNull(versaoMaisNova(json, 5))
        assertNull(versaoMaisNova(json, 6))
    }

    @Test
    fun respostaQueNaoEDoKoraNaoViraAtualizacao() {
        assertNull(versaoMaisNova("""{"error":"Arquivo não encontrado."}""", 1))
        assertNull(versaoMaisNova("""{"versionCode":9}""", 1))
        assertNull(versaoMaisNova("<html>", 1))
    }
}
