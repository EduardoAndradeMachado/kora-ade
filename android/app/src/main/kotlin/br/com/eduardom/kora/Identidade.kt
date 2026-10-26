package br.com.eduardom.kora

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.math.BigInteger
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.cert.X509Certificate
import java.security.spec.ECGenParameterSpec
import java.util.Date
import javax.security.auth.x500.X500Principal

/**
 * A identidade deste celular no envelope do relay: um par ECDSA P-256 criado no Keystore do Android, de onde a chave
 * privada não sai nem para o próprio app. O Keystore gera junto o certificado autoassinado, e a impressão digital dele é
 * o que o PC registra no pareamento.
 */
object IdentidadeDoCelular {
    private const val ALIAS = "kora-celular"
    // A validade não é conferida (o PC confere a impressão digital): longa para o pareamento nunca expirar.
    private const val CEM_ANOS_MS = 100L * 365 * 24 * 60 * 60 * 1000

    fun chave(): ChaveDoCelular {
        val cofre = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        if (!cofre.containsAlias(ALIAS)) {
            val agora = System.currentTimeMillis()
            KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").apply {
                initialize(
                    KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
                        .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                        .setDigests(KeyProperties.DIGEST_SHA256, KeyProperties.DIGEST_NONE)
                        .setCertificateSubject(X500Principal("CN=Kora celular"))
                        .setCertificateSerialNumber(BigInteger.valueOf(agora))
                        .setCertificateNotBefore(Date(agora - 24L * 60 * 60 * 1000))
                        .setCertificateNotAfter(Date(agora + CEM_ANOS_MS))
                        .build()
                )
                generateKeyPair()
            }
        }
        val entrada = cofre.getEntry(ALIAS, null) as KeyStore.PrivateKeyEntry
        return ChaveDoCelular(entrada.privateKey, entrada.certificate as X509Certificate)
    }

    fun impressaoDigital(): String = impressaoDigital(chave().certificado)
}
