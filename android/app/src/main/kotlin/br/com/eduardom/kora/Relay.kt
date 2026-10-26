package br.com.eduardom.kora

import java.security.Signature
import java.util.Base64

/**
 * Prova de posse da chave do celular em cada conexão ao relay, no mesmo formato de relay/auth.ts (mudar lá é mudar
 * aqui): assinatura ECDSA-SHA256 sobre "kora-relay:<caminho>:<instante em ms>", com o certificado junto. O relay só deixa
 * passar celular que algum PC da conta registrou, e confere que a impressão digital é a do certificado que assinou.
 */
fun cabecalhosDoRelay(chave: ChaveDoCelular, caminho: String, cliente: String, agora: Long = System.currentTimeMillis()): Map<String, String> {
    val assinatura = Signature.getInstance("SHA256withECDSA").run {
        initSign(chave.getPrivateKey(null))
        update("kora-relay:$caminho:$agora".toByteArray())
        sign()
    }
    return mapOf(
        "Authorization" to "Kora ${impressaoDigital(chave.certificado)}.$agora.${Base64.getUrlEncoder().withoutPadding().encodeToString(assinatura)}",
        "X-Kora-Certificate" to Base64.getEncoder().encodeToString(chave.certificado.encoded),
        "X-Kora-Client" to cliente
    )
}
