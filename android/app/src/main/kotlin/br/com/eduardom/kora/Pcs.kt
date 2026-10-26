package br.com.eduardom.kora

import org.json.JSONArray
import org.json.JSONObject

/**
 * Um Kora em que o celular já entrou. O id vem do próprio Kora (o instalado e o Dev do mesmo PC têm ids diferentes),
 * e o endereço pode mudar quando o roteador troca o IP do PC. apelido é o nome que a pessoa deu no celular.
 */
// pc e relay: com os dois o app entra de fora pelo relay, conferindo o PC pela impressão digital. host vazio: o PC foi
// pareado só pelo relay e ainda não apareceu na rede local.
data class PcSalvo(val id: String, val host: String, val porta: Int, val nome: String, val apelido: String? = null, val edicao: String = "", val pc: String? = null, val relay: String? = null) {
    val peloRelay: Boolean get() = pc != null && relay != null

    val exibido: String get() = apelido ?: nome
    val tipo: String get() = if (edicao == "dev") "Kora Dev" else "Kora"
}

fun lerPcs(json: String?): List<PcSalvo> {
    val lista = runCatching { JSONArray(json ?: "[]") }.getOrNull() ?: return emptyList()
    return (0 until lista.length()).mapNotNull { indice ->
        val pc = lista.optJSONObject(indice) ?: return@mapNotNull null
        val id = pc.optString("id").ifEmpty { return@mapNotNull null }
        val host = pc.optString("host")
        if (host.isEmpty() && pc.optString("pc").isEmpty()) return@mapNotNull null
        PcSalvo(id, host, pc.optInt("porta", PORTAS.first()), pc.optString("nome").ifEmpty { host }, pc.optString("apelido").ifEmpty { null }, pc.optString("edicao"),
            pc.optString("pc").takeIf { IMPRESSAO_DIGITAL.matches(it) }, relayValido(pc.optString("relay").ifEmpty { null }))
    }
}

fun escreverPcs(pcs: List<PcSalvo>): String = JSONArray(pcs.map { pc ->
    JSONObject().put("id", pc.id).put("host", pc.host).put("porta", pc.porta).put("nome", pc.nome).put("edicao", pc.edicao)
        .apply { pc.apelido?.let { put("apelido", it) } }
        .apply { pc.pc?.let { put("pc", it) } }
        .apply { pc.relay?.let { put("relay", it) } }
}).toString()

// Um Kora de antes do id ficou salvo como "host:porta"; quando ele se atualiza e passa a ter id, é o mesmo PC.
private fun semId(kora: Kora) = "${kora.host}:${kora.porta}"

fun conhecido(pcs: List<PcSalvo>, kora: Kora): Boolean = pcs.any { it.id == kora.id || it.id == semId(kora) }

/** Entrou num Kora: atualiza endereço e nome do que já era conhecido (o apelido fica) ou guarda um novo. */
fun lembrar(pcs: List<PcSalvo>, kora: Kora): List<PcSalvo> {
    val anterior = pcs.find { it.id == semId(kora) }?.takeIf { kora.id != semId(kora) }
    val restantes = if (anterior == null) pcs else pcs.filter { it.id != semId(kora) }
    val conhecido = restantes.find { it.id == kora.id }
    // Pelo relay o /health não traz endereço de casa (host vazio): o que já se sabia dele continua.
    val host = kora.host.ifEmpty { conhecido?.host ?: "" }
    val porta = if (kora.porta == 0) conhecido?.porta ?: PORTAS.first() else kora.porta
    val relay = when (kora.relay) {
        null -> conhecido?.relay
        "" -> null
        else -> kora.relay
    }
    val atualizado = PcSalvo(kora.id, host, porta, kora.nome, conhecido?.apelido ?: anterior?.apelido, kora.edicao, kora.pc ?: conhecido?.pc, relay)
    return if (conhecido == null) restantes + atualizado else restantes.map { if (it.id == kora.id) atualizado else it }
}

/** Onde procurar o PC na rede: só o endereço de casa (vazio no PC pareado só pelo relay). */
fun enderecos(pc: PcSalvo): List<String> = listOfNotNull(pc.host.takeIf { it.isNotEmpty() })

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
