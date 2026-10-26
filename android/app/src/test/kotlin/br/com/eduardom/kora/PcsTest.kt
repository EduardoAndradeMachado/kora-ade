package br.com.eduardom.kora

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PcsTest {
    private val prod = Kora("id-prod", "192.168.0.7", 43127, "Eduardo")
    private val dev = Kora("id-dev", "192.168.0.7", 43128, nomeDoPc("Eduardo", "dev"))

    @Test
    fun osDoisKoraDoMesmoPcFicamGuardadosSeparadosEOVoltaDoDiscoMantemTudo() {
        val pcs = lembrar(lembrar(emptyList(), prod), dev)
        assertEquals(listOf("Eduardo", "Eduardo (Dev)"), pcs.map { it.exibido })
        assertEquals(pcs, lerPcs(escreverPcs(pcs)))
    }

    @Test
    fun oApelidoSobreviveAoPcMudarDeEnderecoENomeVazioVoltaAoNomeDoKora() {
        val renomeado = renomear(lembrar(emptyList(), prod), "id-prod", "  Desktop do escritório ")
        assertEquals("Desktop do escritório", renomeado.single().exibido)
        // O roteador deu outro IP ao PC: o mesmo Kora (mesmo id) continua com o apelido, no endereço novo.
        val mudou = lembrar(renomeado, prod.copy(host = "192.168.0.42"))
        assertEquals(1, mudou.size)
        assertEquals("192.168.0.42", mudou.single().host)
        assertEquals("Desktop do escritório", mudou.single().exibido)
        assertEquals("Eduardo", renomear(mudou, "id-prod", "   ").single().exibido)
    }

    @Test
    fun oKoraDeAntesDoIdQueSeAtualizaContinuaSendoUmPcSoComOApelido() {
        val antigo = Kora("192.168.0.7:43127", "192.168.0.7", 43127, "Eduardo")
        val salvo = renomear(lembrar(lembrar(emptyList(), antigo), dev), antigo.id, "Desktop")
        val atualizado = lembrar(salvo, prod)
        assertEquals(listOf("id-dev", "id-prod"), atualizado.map { it.id })
        assertEquals("Desktop", atualizado.last().exibido)
    }

    @Test
    fun esquecerTiraSoAquelePcEOTipoVoltaDoDisco() {
        val pcs = lembrar(lembrar(emptyList(), prod), dev.copy(edicao = "dev"))
        assertEquals(listOf("Kora", "Kora Dev"), lerPcs(escreverPcs(pcs)).map { it.tipo })
        assertEquals(listOf("id-dev"), esquecer(pcs, "id-prod").map { it.id })
    }

    @Test
    fun oKoraAtualizadoEncontradoNaRedeEReconhecidoComoOPcSalvo() {
        val antigo = Kora("192.168.0.7:43127", "192.168.0.7", 43127, "Eduardo")
        val salvos = lembrar(emptyList(), antigo)
        assertEquals(true, conhecido(salvos, prod))
        assertEquals(false, conhecido(salvos, dev))
    }

    @Test
    fun esquecerApagaOCookieDaquelePcEOAntigoSoQuandoNinguemMaisUsaOEndereco() {
        val pcs = lembrar(lembrar(emptyList(), prod), dev)
        assertEquals(listOf("kora-device-id-prod"), cookiesParaApagar(pcs, pcs[0]))
        val sozinho = lembrar(emptyList(), prod)
        assertEquals(listOf("kora-device-id-prod", "kora-device"), cookiesParaApagar(sozinho, sozinho[0]))
        val antigo = lembrar(emptyList(), Kora("192.168.0.7:43127", "192.168.0.7", 43127, "Eduardo"))
        assertEquals(listOf("kora-device"), cookiesParaApagar(antigo, antigo[0]))
    }

    @Test
    fun oEstadoDoPcSaiDaBuscaEDaRespostaDoPareamento() {
        assertEquals(Situacao.PROCURANDO, situacao(null, null))
        assertEquals(Situacao.DESLIGADO, situacao(false, null))
        assertEquals(Situacao.PRECISA_PAREAR, situacao(true, pareadoPelaResposta(401)))
        assertEquals(Situacao.PRONTO, situacao(true, pareadoPelaResposta(200)))
        // Resposta inesperada não trava a pessoa fora: abre a página e ela decide.
        assertEquals(Situacao.PRONTO, situacao(true, pareadoPelaResposta(404)))
    }

    @Test
    fun listaSalvaEstragadaNaoDerrubaOApp() {
        assertEquals(emptyList<PcSalvo>(), lerPcs(null))
        assertEquals(emptyList<PcSalvo>(), lerPcs("{não é lista"))
        assertEquals(emptyList<PcSalvo>(), lerPcs("""[{"host":"192.168.0.7"},{"id":"sem-host"}]"""))
    }

    @Test
    fun pcSalvoPorVersaoAntigaComEnderecoExtraNoJsonSoProcuraOEnderecoDeCasa() {
        val salvo = lerPcs("""[{"id":"id-prod","host":"192.168.0.7","porta":43127,"nome":"Eduardo","edicao":"","tailscale":"100.74.20.52"}]""")
        assertEquals(listOf("192.168.0.7"), enderecos(salvo.single()))
        assertEquals(listOf(PcSalvo("id-prod", "192.168.0.7", 43127, "Eduardo")), salvo)
        // Gravar de novo descarta a chave que o app não usa mais.
        assertTrue("100.74.20.52" !in escreverPcs(salvo))
    }

    @Test
    fun oPcEORelayVemDoHealthESomemQuandoOPcDesligaForaDeCasa() {
        val pc = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        val ligado = lembrar(emptyList(), prod.copy(pc = pc, relay = "kora-sync.eduardom.com.br")).single()
        assertTrue(ligado.peloRelay)
        assertEquals(listOf(ligado), lerPcs(escreverPcs(listOf(ligado))))
        // Kora antigo, que não fala do relay: o que já se sabia continua.
        assertEquals("kora-sync.eduardom.com.br", lembrar(listOf(ligado), prod).single().relay)
        // O PC informou que Fora de casa está desligado: o app para de tentar pelo relay.
        val desligado = lembrar(listOf(ligado), prod.copy(pc = pc, relay = "")).single()
        assertEquals(null, desligado.relay)
        assertEquals(false, desligado.peloRelay)
        assertEquals(pc, desligado.pc)
    }

    @Test
    fun pcPareadoSoPeloRelayFicaSalvoSemEnderecoDeCasa() {
        val soRelay = PcSalvo("id-prod", "", 43127, "Eduardo", pc = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", relay = "kora-sync.eduardom.com.br")
        assertEquals(listOf(soRelay), lerPcs(escreverPcs(listOf(soRelay))))
        assertEquals(emptyList<String>(), enderecos(soRelay))
        // Quando ele aparece na rede de casa, ganha o endereço e mantém o relay.
        val emCasa = lembrar(listOf(soRelay), prod).single()
        assertEquals("192.168.0.7", emCasa.host)
        assertTrue(emCasa.peloRelay)
    }

    @Test
    fun oHealthQueChegaPeloRelayNaoApagaOEnderecoDeCasa() {
        val emCasa = lembrar(emptyList(), prod.copy(pc = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", relay = "kora-sync.eduardom.com.br")).single()
        // O /health lido pelo envelope não traz endereço nem porta da rede local.
        val peloRelay = lembrar(listOf(emCasa), Kora("id-prod", "", 0, "Eduardo", pc = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", relay = "kora-sync.eduardom.com.br")).single()
        assertEquals("192.168.0.7", peloRelay.host)
        assertEquals(43127, peloRelay.porta)
        assertTrue(peloRelay.peloRelay)
    }
}
