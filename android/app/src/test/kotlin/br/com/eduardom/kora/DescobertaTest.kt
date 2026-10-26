package br.com.eduardom.kora

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DescobertaTest {
    @Test
    fun vizinhosCobremA24InteiraMenosOProprioCelularComOsMaisProximosPrimeiro() {
        val lista = vizinhos("192.168.0.20")
        assertEquals(253, lista.size)
        assertEquals(setOf("192.168.0.19", "192.168.0.21"), lista.take(2).toSet())
        assertEquals(setOf("192.168.0.18", "192.168.0.22"), lista.subList(2, 4).toSet())
        assertEquals((1..254).filter { it != 20 }.map { "192.168.0.$it" }.toSet(), lista.toSet())
        assertEquals(emptyList<String>(), vizinhos("fe80::1"))
    }

    @Test
    fun conviteSoAceitaOQrDoKora() {
        assertEquals(Convite("192.168.0.10", 43127, "abc-123"), lerConvite("http://192.168.0.10:43127/#pair=abc-123"))
        // O Kora Dev fica noutra porta, para os dois do mesmo PC estarem ligados juntos.
        assertEquals(Convite("192.168.0.10", 43128, "xyz"), lerConvite("http://192.168.0.10:43128/#pair=xyz"))
        assertNull(lerConvite("https://192.168.0.10:43127/#pair=abc"))
        assertNull(lerConvite("http://192.168.0.10:8080/#pair=abc"))
        assertNull(lerConvite("http://exemplo.com:43127/#pair=abc"))
        assertNull(lerConvite("http://192.168.0.10:43127/"))
        assertNull(lerConvite("http://192.168.0.10:43127/#outra=abc"))
        assertNull(lerConvite("texto qualquer"))
    }

    @Test
    fun conviteLevaOPcEORelayEOAppAtualContinuaLendoOMesmo() {
        val pc = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        assertEquals(Convite("192.168.0.10", 43127, "abc", pc, "kora-sync.eduardom.com.br"), lerConvite("http://192.168.0.10:43127/?pc=$pc&relay=kora-sync.eduardom.com.br#pair=abc"))
        assertEquals(Convite("192.168.0.10", 43127, "abc", pc, null), lerConvite("http://192.168.0.10:43127/?pc=$pc#pair=abc"))
        // Só com Fora de casa ligado o QR aponta para o relay.
        assertEquals(Convite(null, 0, "abc", pc, "kora-sync.eduardom.com.br"), lerConvite("https://kora-sync.eduardom.com.br/?pc=$pc#pair=abc"))
        // Pelo relay sem a impressão digital do PC, o app não teria como conferir quem responde: não é convite.
        assertNull(lerConvite("https://kora-sync.eduardom.com.br/#pair=abc"))
        assertNull(lerConvite("https://kora-sync.eduardom.com.br/?pc=curto#pair=abc"))
        assertNull(lerConvite("https://kora-sync.eduardom.com.br:8443/?pc=$pc#pair=abc"))
        // Relay com cara de outra coisa é ignorado, e o convite da rede local continua valendo.
        assertEquals(Convite("192.168.0.10", 43127, "abc", pc, null), lerConvite("http://192.168.0.10:43127/?pc=$pc&relay=javascript:alert(1)#pair=abc"))
    }
}
