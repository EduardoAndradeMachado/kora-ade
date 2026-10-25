package br.com.eduardom.kora

import java.net.URI

// A porta fixa do servidor do celular no Kora do PC (src/main/mobile-server.ts).
const val PORTA = 43127

data class Kora(val host: String, val nome: String)

data class Convite(val host: String, val codigo: String)

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

/** O QR code do PC: http://<ip>:43127/#pair=<código>. Qualquer outra coisa não é convite do Kora. */
fun lerConvite(texto: String): Convite? {
    val uri = runCatching { URI(texto.trim()) }.getOrNull() ?: return null
    if (uri.scheme != "http" || uri.port != PORTA) return null
    val host = uri.host?.takeIf { ipv4(it) != null } ?: return null
    val codigo = uri.rawFragment?.removePrefix("pair=")?.takeIf { it != uri.rawFragment && it.isNotBlank() } ?: return null
    return Convite(host, codigo)
}
