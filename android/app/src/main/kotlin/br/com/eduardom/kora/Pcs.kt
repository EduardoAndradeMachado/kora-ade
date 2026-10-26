package br.com.eduardom.kora

import org.json.JSONArray
import org.json.JSONObject

/**
 * Um Kora em que o celular já entrou. O id vem do próprio Kora (o instalado e o Dev do mesmo PC têm ids diferentes),
 * e o endereço pode mudar quando o roteador troca o IP do PC. apelido é o nome que a pessoa deu no celular.
 */
data class PcSalvo(val id: String, val host: String, val porta: Int, val nome: String, val apelido: String? = null, val edicao: String = "", val tailscale: String? = null) {
    val exibido: String get() = apelido ?: nome
    val tipo: String get() = if (edicao == "dev") "Kora Dev" else "Kora"
}

fun lerPcs(json: String?): List<PcSalvo> {
    val lista = runCatching { JSONArray(json ?: "[]") }.getOrNull() ?: return emptyList()
    return (0 until lista.length()).mapNotNull { indice ->
        val pc = lista.optJSONObject(indice) ?: return@mapNotNull null
        val id = pc.optString("id").ifEmpty { return@mapNotNull null }
        val host = pc.optString("host").ifEmpty { return@mapNotNull null }
        PcSalvo(id, host, pc.optInt("porta", PORTAS.first()), pc.optString("nome").ifEmpty { host }, pc.optString("apelido").ifEmpty { null }, pc.optString("edicao"), pc.optString("tailscale").ifEmpty { null })
    }
}

fun escreverPcs(pcs: List<PcSalvo>): String = JSONArray(pcs.map { pc ->
    JSONObject().put("id", pc.id).put("host", pc.host).put("porta", pc.porta).put("nome", pc.nome).put("edicao", pc.edicao)
        .apply { pc.apelido?.let { put("apelido", it) } }
        .apply { pc.tailscale?.let { put("tailscale", it) } }
}).toString()

// Um Kora de antes do id ficou salvo como "host:porta"; quando ele se atualiza e passa a ter id, é o mesmo PC.
private fun semId(kora: Kora) = "${kora.host}:${kora.porta}"

fun conhecido(pcs: List<PcSalvo>, kora: Kora): Boolean = pcs.any { it.id == kora.id || it.id == semId(kora) }

/** Entrou num Kora: atualiza endereço e nome do que já era conhecido (o apelido fica) ou guarda um novo. */
fun lembrar(pcs: List<PcSalvo>, kora: Kora): List<PcSalvo> {
    val anterior = pcs.find { it.id == semId(kora) }?.takeIf { kora.id != semId(kora) }
    val restantes = if (anterior == null) pcs else pcs.filter { it.id != semId(kora) }
    val conhecido = restantes.find { it.id == kora.id }
    // Entrar pelo Tailscale não troca o endereço de casa: em casa o app continua indo direto pela rede local.
    val host = if (conhecido != null && kora.host == kora.tailscale) conhecido.host else kora.host
    val atualizado = PcSalvo(kora.id, host, kora.porta, kora.nome, conhecido?.apelido ?: anterior?.apelido, kora.edicao, kora.tailscale ?: conhecido?.tailscale)
    return if (conhecido == null) restantes + atualizado else restantes.map { if (it.id == kora.id) atualizado else it }
}

/** Onde procurar o PC: primeiro o endereço de casa, depois o do Tailscale. */
fun enderecos(pc: PcSalvo): List<String> = listOfNotNull(pc.host, pc.tailscale?.takeIf { it != pc.host })

/** Os cookies de pareamento do Kora (src/main/mobile-server.ts, cookieName) no cabeçalho que o CookieManager devolve. */
fun cookiesDePareamento(cabecalho: String?): List<String> =
    cabecalho.orEmpty().split(';').map { it.trim() }.filter { it.startsWith("kora-device") && '=' in it }

/** Nome vazio volta ao nome que o próprio Kora informa. */
fun renomear(pcs: List<PcSalvo>, id: String, apelido: String): List<PcSalvo> =
    pcs.map { if (it.id == id) it.copy(apelido = apelido.trim().take(60).ifEmpty { null }) else it }

fun esquecer(pcs: List<PcSalvo>, id: String): List<PcSalvo> = pcs.filter { it.id != id }

enum class Situacao(val rotulo: String) {
    PROCURANDO("Procurando…"),
    PRONTO("Pronto"),
    PRECISA_PAREAR("Precisa parear"),
    DESLIGADO("Desligado ou fora da rede")
}

/** respondeu: null enquanto a busca não chegou nele. pareado: null quando o PC não disse (a página decide). */
fun situacao(respondeu: Boolean?, pareado: Boolean?): Situacao = when {
    respondeu == null -> Situacao.PROCURANDO
    !respondeu -> Situacao.DESLIGADO
    pareado == false -> Situacao.PRECISA_PAREAR
    else -> Situacao.PRONTO
}

/** GET /api/device com o cookie do celular: 200 é pareado, 401 é não pareado (src/main/mobile-server.ts). */
fun pareadoPelaResposta(codigo: Int): Boolean? = when (codigo) {
    200 -> true
    401 -> false
    else -> null
}

/**
 * Cookies de pareamento que saem ao esquecer o PC (src/main/mobile-server.ts, cookieName). Cookie não separa por
 * porta, e o "kora-device" de antes do id serve a qualquer Kora daquele endereço: só sai quando nenhum outro PC salvo
 * está no mesmo endereço.
 */
fun cookiesParaApagar(pcs: List<PcSalvo>, pc: PcSalvo): List<String> {
    val antigo = pc.id == "${pc.host}:${pc.porta}"
    val sozinho = pcs.none { it.id != pc.id && it.host == pc.host }
    return listOfNotNull(if (antigo) "kora-device" else "kora-device-${pc.id}", "kora-device".takeIf { sozinho && !antigo })
}
