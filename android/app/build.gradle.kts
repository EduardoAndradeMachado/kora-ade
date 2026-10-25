import java.util.Properties

plugins {
    id("com.android.application")
}

// A chave de release fica fora do repositório: no PC do Eduardo em ~/.kora-celular, no CI num secret.
// Sem ela o Android recusa a atualização por cima, porque a assinatura do app instalado não bate.
val assinatura = listOfNotNull(System.getenv("KORA_KEYSTORE_PROPERTIES"), "${System.getProperty("user.home")}/.kora-celular/keystore.properties")
    .map(::File)
    .firstOrNull { it.exists() }
    ?.let { arquivo -> Properties().apply { arquivo.inputStream().use(::load) } }

android {
    namespace = "br.com.eduardom.kora"
    compileSdk = 37

    defaultConfig {
        applicationId = "br.com.eduardom.kora"
        // Android 11: dá para ler os recuos do teclado e das barras pela API da plataforma, sem compat.
        minSdk = 30
        targetSdk = 37
        // O Kora do PC compara este número com o do app instalado para oferecer a atualização.
        versionCode = 9
        versionName = "0.2.5"
    }

    signingConfigs {
        if (assinatura != null) create("release") {
            storeFile = File(assinatura.getProperty("storeFile"))
            storePassword = assinatura.getProperty("storePassword")
            keyAlias = assinatura.getProperty("keyAlias")
            keyPassword = assinatura.getProperty("keyPassword")
        }
    }

    buildTypes {
        release {
            signingConfig = signingConfigs.findByName("release")
        }
    }

    lint {
        // O app só fala português.
        disable += setOf("SetTextI18n")
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation("androidx.activity:activity:1.13.0")
    // Leitor de QR do Google Play services: abre a câmera dele mesmo, sem pedir permissão de câmera ao app.
    implementation("com.google.android.gms:play-services-code-scanner:16.1.0")
    // O leitor de QR traz o fragment 1.0, que perde o resultado de registerForActivityResult (a galeria da imagem).
    implementation("androidx.fragment:fragment:1.9.1")
    testImplementation("junit:junit:4.13.2")
    // O org.json do Android é só um esboço nos testes de JVM; este é o de verdade, com o mesmo pacote.
    testImplementation("org.json:json:20250517")
}
