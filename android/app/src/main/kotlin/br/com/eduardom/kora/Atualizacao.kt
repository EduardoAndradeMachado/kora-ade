package br.com.eduardom.kora

import org.json.JSONObject

data class VersaoDoApp(val codigo: Long, val nome: String)

/** O que o Kora do PC responde em /app/android.json (src/main/mobile-server.ts). Só oferece versão mais nova. */
fun versaoMaisNova(json: String, instalada: Long): VersaoDoApp? {
    val dados = runCatching { JSONObject(json) }.getOrNull() ?: return null
    val codigo = dados.optLong("versionCode", -1)
    val nome = dados.optString("versionName").ifEmpty { return null }
    return if (codigo > instalada) VersaoDoApp(codigo, nome) else null
}
