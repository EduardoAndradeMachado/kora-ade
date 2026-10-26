package br.com.eduardom.kora

import java.net.URI

/**
 * O botão Baixar da tela (src/renderer/src/mobile/downloads.ts) pede ao app um link de leitura do PC aberto. Só esse
 * endereço passa: a ponte KoraApp também chega ao HTML do projeto na prévia, e o app não vira um baixador de qualquer
 * coisa da rede (ou do 127.0.0.1 de outro app).
 */
fun enderecoParaBaixar(endereco: String, host: String, porta: Int): URI? {
    val uri = runCatching { URI(endereco) }.getOrNull() ?: return null
    if (uri.scheme != "http" || uri.host != host || uri.port != porta || uri.rawUserInfo != null) return null
    val caminho = uri.rawPath ?: return null
    if (!caminho.startsWith("/raw/") || uri.rawQuery != null || uri.rawFragment != null) return null
    return uri
}

/** Nome que vira arquivo em Downloads: sem pasta, sem caractere de controle, sem começar com ponto; o nome comprido
 * perde o fim do nome, não a extensão. */
fun nomeParaSalvar(nome: String): String {
    val limpo = nome.substringAfterLast('/').substringAfterLast('\\')
        .filterNot { it.isISOControl() || it in "<>:\"|?*" }
        .trim().trimStart('.')
    if (limpo.isEmpty()) return "arquivo"
    if (limpo.codePointCount(0, limpo.length) <= MAX_NOME) return limpo
    val extensao = limpo.substringAfterLast('.', "").takeIf { it.isNotEmpty() && it.length <= 10 }?.let { ".$it" } ?: ""
    val base = limpo.removeSuffix(extensao)
    return base.substring(0, base.offsetByCodePoints(0, MAX_NOME - extensao.length)) + extensao
}

private const val MAX_NOME = 120

/**
 * A chave da ponte (microfone, Baixar) vai só para a tela do Kora. O HTML do projeto também pode virar a página
 * principal (Abrir página inteira pelo relay, window.open da prévia): com a chave, ele gravaria o microfone e baixaria
 * arquivos sem a pessoa pedir.
 */
fun recebeAChave(endereco: String?): Boolean {
    if (endereco.isNullOrBlank()) return false
    val caminho = runCatching { URI(endereco).rawPath }.getOrNull() ?: return false
    return !caminho.startsWith("/raw/")
}

/** O tipo que o PC mandou, sem o charset; o genérico quando não veio. */
fun tipoDoArquivo(contentType: String?): String =
    contentType?.substringBefore(';')?.trim()?.lowercase()?.takeIf { Regex("^[a-z0-9.+-]+/[a-z0-9.+-]+$").matches(it) }
        ?: "application/octet-stream"
