package br.com.eduardom.kora

import java.net.URI

// As portas do servidor do celular no Kora do PC (src/main/index.ts): a do Kora instalado e a do Kora Dev, que
// fica noutra para os dois poderem estar ligados ao mesmo tempo.
val PORTAS = listOf(43127, 43128)

// tailscale: o endereço do PC no Tailscale, que o /health informa; com ele o celular chega ao PC fora de casa.
data class Kora(val id: String, val host: String, val porta: Int, val nome: String, val edicao: String = "", val tailscale: String? = null)

data class Convite(val host: String, val porta: Int, val codigo: String)

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

/** O QR code do PC: http://<ip>:<porta do Kora>/#pair=<código>. Qualquer outra coisa não é convite do Kora. */
fun lerConvite(texto: String): Convite? {
    val uri = runCatching { URI(texto.trim()) }.getOrNull() ?: return null
    if (uri.scheme != "http" || uri.port !in PORTAS) return null
    val host = uri.host?.takeIf { ipv4(it) != null } ?: return null
    val codigo = uri.rawFragment?.removePrefix("pair=")?.takeIf { it != uri.rawFragment && it.isNotBlank() } ?: return null
    return Convite(host, uri.port, codigo)
}
