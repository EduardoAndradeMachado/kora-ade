package br.com.eduardom.kora

import java.net.URI

// As portas do servidor do celular no Kora do PC (src/main/index.ts): a do Kora instalado e a do Kora Dev, que
// fica noutra para os dois poderem estar ligados ao mesmo tempo.
val PORTAS = listOf(43127, 43128)

// pc e relay: a impressão digital do certificado do PC e o relay em que ele está (Fora de casa). relay null quer dizer
// que o /health não falou dele (Kora antigo); vazio, que o PC informou que Fora de casa está desligado.
data class Kora(val id: String, val host: String, val porta: Int, val nome: String, val edicao: String = "", val pc: String? = null, val relay: String? = null)

// host null: o QR veio só pelo relay (Fora de casa ligado, rede local desligada); o pareamento vai pelo relay.
data class Convite(val host: String?, val porta: Int, val codigo: String, val pc: String? = null, val relay: String? = null)

val IMPRESSAO_DIGITAL = Regex("^[0-9a-f]{64}$")
private val DOMINIO = Regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\\d{1,5})?$")
fun relayValido(host: String?): String? = host?.lowercase()?.takeIf { DOMINIO.matches(it) }

private fun ipv4(texto: String): List<Int>? {
    val partes = texto.split('.')
    if (partes.size != 4) return null
    val numeros = partes.map { it.toIntOrNull() ?: return null }
    return numeros.takeIf { lista -> lista.all { it in 0..255 } }
}

/**
 * Os outros endereços da /24 do celular, dos mais próximos para os mais distantes: o roteador costuma dar
 * IPs vizinhos aos aparelhos da casa, então o PC aparece antes.
 */
fun vizinhos(ip: String): List<String> {
    val (a, b, c, d) = ipv4(ip) ?: return emptyList()
    return (1..254).filter { it != d }.sortedBy { kotlin.math.abs(it - d) }.map { "$a.$b.$c.$it" }
}

/** O instalado e o Dev do mesmo PC têm o mesmo nome de computador: o Dev ganha a marca. */
fun nomeDoPc(nome: String, edicao: String): String = if (edicao == "dev") "$nome (Dev)" else nome

/**
 * O QR code do PC (src/main/mobile-server.ts, invite). Pela rede local: http://<ip>:<porta do Kora>/?pc=…&relay=…#pair=…,
 * em que pc e relay só existem com Fora de casa. Só pelo relay: https://<relay>/?pc=…#pair=…. Outra coisa não é do Kora.
 */
fun lerConvite(texto: String): Convite? {
    val uri = runCatching { URI(texto.trim()) }.getOrNull() ?: return null
    val codigo = uri.rawFragment?.removePrefix("pair=")?.takeIf { it != uri.rawFragment && it.isNotBlank() } ?: return null
    val consulta = uri.rawQuery.orEmpty().split('&').mapNotNull { par -> par.split('=', limit = 2).takeIf { it.size == 2 }?.let { it[0] to it[1] } }.toMap()
    val pc = consulta["pc"]?.takeIf { IMPRESSAO_DIGITAL.matches(it) }
    return when {
        uri.scheme == "http" && uri.port in PORTAS && uri.host?.let(::ipv4) != null -> Convite(uri.host, uri.port, codigo, pc, relayValido(consulta["relay"]))
        uri.scheme == "https" && uri.port == -1 && pc != null && relayValido(uri.host) != null -> Convite(null, 0, codigo, pc, relayValido(uri.host))
        else -> null
    }
}
