package br.com.eduardom.kora

import android.animation.ObjectAnimator
import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.Intent
import android.net.Uri
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.ConnectivityManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.view.WindowInsets
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.core.content.FileProvider
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.Inet4Address
import java.io.File
import java.net.URL
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

private const val TAG = "kora"
private const val HOST_SALVO = "host"
private const val FUNDO = 0xFF16171B.toInt()
private const val TEXTO = 0xFFF3E6D0.toInt()
private const val APAGADO = 0xFF9A9CA5.toInt()
private const val AMBAR = 0xFFD98E3A.toInt()
private const val CARTAO = 0xFF22242A.toInt()

// Vizinho que não existe não responde ao ARP e só desiste no tempo limite: muitos em paralelo e tempo curto.
private const val SONDAS_EM_PARALELO = 64
private const val CONECTAR_MS = 400
private const val LER_MS = 1500
// Se a página não avisar que está pronta (versão antiga do Kora no PC), ela aparece assim mesmo.
private const val ESPERA_PAGINA_MS = 6000L

class MainActivity : ComponentActivity() {
    private lateinit var web: WebView
    private lateinit var abertura: View
    private lateinit var inicio: View
    private lateinit var situacao: TextView
    private lateinit var achados: LinearLayout
    private val principal = Handler(Looper.getMainLooper())
    // A página pede imagem pelo <input type="file">; a WebView só abre a galeria se o app atender o pedido.
    private var escolhaDeArquivo: ValueCallback<Array<Uri>>? = null
    private val escolherArquivo = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { resultado ->
        val dados = resultado.data
        val clip = dados?.clipData
        val arquivos = when {
            resultado.resultCode != RESULT_OK -> null
            clip != null -> Array(clip.itemCount) { clip.getItemAt(it).uri }
            dados?.data != null -> arrayOf(dados.data!!)
            else -> null
        }
        val callback = escolhaDeArquivo
        escolhaDeArquivo = null
        if (arquivos == null) {
            callback?.onReceiveValue(null)
            return@registerForActivityResult
        }
        // A permissão de ler a foto da galeria vale só agora: a página lê o arquivo depois, quando ela já pode ter
        // caído (NotReadableError). Copiar para o cache do app e entregar a cópia tira a galeria do caminho.
        Thread {
            val copias = runCatching { arquivos.map(::copiarParaCache).toTypedArray() }
                .onFailure { Log.w(TAG, "falha ao copiar a imagem escolhida", it) }
                .getOrNull()
            principal.post { callback?.onReceiveValue(copias) }
        }.start()
    }
    private fun copiarParaCache(origem: Uri): Uri {
        val pasta = File(cacheDir, "imagens").apply { mkdirs() }
        // As cópias só servem até a página ler; as de escolhas antigas saem aqui.
        pasta.listFiles()?.filter { System.currentTimeMillis() - it.lastModified() > 3_600_000 }?.forEach { it.delete() }
        val extensao = when (contentResolver.getType(origem)) {
            "image/png" -> "png"
            "image/webp" -> "webp"
            "image/gif" -> "gif"
            else -> "jpg"
        }
        val destino = File(pasta, "imagem-${System.nanoTime()}.$extensao")
        val entrada = contentResolver.openInputStream(origem) ?: error("a galeria não entregou a imagem")
        entrada.use { dados -> destino.outputStream().use { dados.copyTo(it) } }
        return FileProvider.getUriForFile(this, "$packageName.arquivos", destino)
    }

    private val preferencias by lazy { getSharedPreferences("kora", MODE_PRIVATE) }
    private var busca: ExecutorService? = null
    // Cada busca nova invalida as respostas atrasadas da anterior.
    private var geracao = 0
    private var hostAtual: String? = null
    private var nomeAtual: String? = null
    // Pergunta uma vez por PC enquanto o app está aberto; "Depois" não insiste até a próxima abertura.
    private val versaoConferida = mutableSetOf<String>()

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        CookieManager.getInstance().setAcceptCookie(true)
        web = criarWebView()
        abertura = criarAbertura()
        inicio = criarInicio()
        val raiz = FrameLayout(this).apply {
            setBackgroundColor(FUNDO)
            addView(web, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
            addView(inicio, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
            addView(abertura, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
            // Com a tela de ponta a ponta, o teclado não encolhe a janela sozinho: o recuo dele vira padding,
            // e a página (visualViewport) mantém o campo de mensagem acima do teclado.
            setOnApplyWindowInsetsListener { view, insets ->
                val recuo = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.ime() or WindowInsets.Type.displayCutout())
                view.setPadding(recuo.left, recuo.top, recuo.right, recuo.bottom)
                WindowInsets.CONSUMED
            }
        }
        setContentView(raiz)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (web.visibility == View.VISIBLE && web.canGoBack()) web.goBack() else finish()
            }
        })

        // Até decidir o que mostrar, só a logo: nada de telas piscando enquanto o app procura o PC.
        val salvo = preferencias.getString(HOST_SALVO, null)
        if (salvo == null) procurar() else {
            mostrarAbertura()
            Thread {
                val kora = sondar(salvo)
                principal.post { if (kora != null) abrir(kora) else procurar() }
            }.start()
        }
    }

    override fun onPause() {
        super.onPause()
        CookieManager.getInstance().flush()
    }

    override fun onDestroy() {
        busca?.shutdownNow()
        super.onDestroy()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun criarWebView() = WebView(this).apply {
        setBackgroundColor(FUNDO)
        visibility = View.GONE
        with(settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            setSupportZoom(false)
        }
        webViewClient = Cliente()
        webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                escolhaDeArquivo?.onReceiveValue(null)
                escolhaDeArquivo = callback
                val pedido = params.createIntent().putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.mode == FileChooserParams.MODE_OPEN_MULTIPLE)
                return runCatching { escolherArquivo.launch(pedido) }.onFailure {
                    escolhaDeArquivo = null
                    Log.w(TAG, "sem app para escolher imagem", it)
                }.isSuccess
            }
        }
        addJavascriptInterface(Ponte(), "KoraApp")
    }

    /** Contrato com src/renderer/src/mobile/api.ts. Chamado pela thread do JavaBridge, não pela principal. */
    private inner class Ponte {
        @JavascriptInterface
        fun lerQr() = runOnUiThread { lerQrCode() }

        @JavascriptInterface
        fun escolherPc() = runOnUiThread { procurar(escolher = true) }

        @JavascriptInterface
        fun pronto() = runOnUiThread { mostrarPagina() }

        @JavascriptInterface
        fun versao(): String = packageManager.getPackageInfo(packageName, 0).versionName.orEmpty()

        @JavascriptInterface
        fun buscarAtualizacao() = runOnUiThread { hostAtual?.let { conferirVersao(it, pedida = true) } }
    }

    private inner class Cliente : WebViewClient() {
        // Só a página do Kora roda dentro do app (a ponte KoraApp fica exposta a ela); link de fora vai para o navegador.
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            if (request.url.host == hostAtual && request.url.port == PORTA) return false
            runCatching { startActivity(Intent(Intent.ACTION_VIEW, request.url)) }
            return true
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (!request.isForMainFrame) return
            Log.w(TAG, "falha ao abrir ${request.url}: ${error.errorCode} ${error.description}")
            procurar("Não consegui abrir o Kora${nomeAtual?.let { " do PC $it" } ?: ""}. O PC está ligado, com a conexão do celular ativa?")
        }
    }

    private fun abrir(kora: Kora, codigo: String? = null) {
        hostAtual = kora.host
        nomeAtual = kora.nome
        preferencias.edit().putString(HOST_SALVO, kora.host).apply()
        busca?.shutdownNow()
        val minha = ++geracao
        mostrarAbertura()
        // A página carrega por baixo da logo e só aparece quando avisa (KoraApp.pronto) que tem o que mostrar.
        web.visibility = View.INVISIBLE
        // A query força uma navegação nova: só trocar o #pair numa página já aberta não a recarregaria.
        web.loadUrl(if (codigo == null) "http://${kora.host}:$PORTA/" else "http://${kora.host}:$PORTA/?convite=${System.currentTimeMillis()}#pair=$codigo")
        principal.postDelayed({ if (minha == geracao && web.visibility != View.VISIBLE) mostrarPagina() }, ESPERA_PAGINA_MS)
    }

    private fun mostrarAbertura() {
        abertura.visibility = View.VISIBLE
        inicio.visibility = View.GONE
    }

    private fun mostrarPagina() {
        if (inicio.visibility == View.VISIBLE) return
        web.visibility = View.VISIBLE
        abertura.visibility = View.GONE
        hostAtual?.let(::conferirVersao)
    }

    // O instalador do Kora do PC leva o APK junto: quando o PC se atualiza pelo GitHub, o app se atualiza por ele.
    // pedida: a pessoa tocou em Buscar atualização, então a resposta aparece mesmo quando não há versão nova.
    private fun conferirVersao(host: String, pedida: Boolean = false) {
        if (!versaoConferida.add(host) && !pedida) return
        val instalada = packageManager.getPackageInfo(packageName, 0).longVersionCode
        Thread {
            val consulta = runCatching {
                val conexao = URL("http://$host:$PORTA/app/android.json").openConnection() as HttpURLConnection
                conexao.connectTimeout = 2000
                conexao.readTimeout = 3000
                try {
                    if (conexao.responseCode != 200) null
                    else versaoMaisNova(conexao.inputStream.bufferedReader().readText(), instalada)
                } finally {
                    conexao.disconnect()
                }
            }
            val nova = consulta.getOrNull()
            principal.post {
                if (isFinishing) return@post
                if (nova == null) {
                    if (pedida) {
                        val aviso = if (consulta.isFailure) "Não deu para consultar o Kora do PC." else "O app já está na versão mais nova que veio com o PC."
                        Toast.makeText(this, aviso, Toast.LENGTH_LONG).show()
                    }
                    return@post
                }
                AlertDialog.Builder(this)
                    .setTitle("Atualização do app")
                    .setMessage("A versão ${nova.nome} do app Kora veio junto com o Kora do seu PC.")
                    .setPositiveButton("Atualizar") { _, _ -> baixarAtualizacao(host) }
                    .setNegativeButton("Depois", null)
                    .show()
            }
        }.start()
    }

    private fun baixarAtualizacao(host: String) {
        Toast.makeText(this, "Baixando a atualização do PC…", Toast.LENGTH_SHORT).show()
        Thread {
            val arquivo = runCatching {
                val pasta = File(cacheDir, "atualizacao").apply { mkdirs() }
                val destino = File(pasta, "kora.apk")
                val conexao = URL("http://$host:$PORTA/app/kora-celular.apk").openConnection() as HttpURLConnection
                conexao.connectTimeout = 2000
                conexao.readTimeout = 15000
                try {
                    check(conexao.responseCode == 200) { "o PC respondeu ${conexao.responseCode}" }
                    conexao.inputStream.use { entrada -> destino.outputStream().use { entrada.copyTo(it) } }
                } finally {
                    conexao.disconnect()
                }
                destino
            }
            principal.post {
                arquivo.onSuccess { apk ->
                    val endereco = FileProvider.getUriForFile(this, "$packageName.arquivos", apk)
                    // Na primeira vez o Android pede para permitir instalar apps vindos do Kora.
                    startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(endereco, "application/vnd.android.package-archive").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
                }.onFailure { erro ->
                    Log.w(TAG, "falha ao baixar a atualização", erro)
                    Toast.makeText(this, "Não deu para baixar a atualização: ${erro.message}", Toast.LENGTH_LONG).show()
                }
            }
        }.start()
    }

    private fun mostrarInicio(texto: String) {
        situacao.text = texto
        inicio.visibility = View.VISIBLE
        abertura.visibility = View.GONE
        web.visibility = View.GONE
    }

    // escolher: a pessoa pediu outro PC, então nem um Kora só na rede abre sozinho.
    private fun procurar(motivo: String? = null, escolher: Boolean = false) {
        achados.removeAllViews()
        val ip = ipDoCelular()
        if (ip == null) {
            mostrarInicio(motivo ?: "Conecte o celular ao Wi-Fi de casa para achar o Kora do PC.")
            return
        }
        mostrarInicio(motivo ?: "Procurando o Kora na rede…")
        val minha = ++geracao
        busca?.shutdownNow()
        val enderecos = vizinhos(ip)
        val pool = Executors.newFixedThreadPool(SONDAS_EM_PARALELO).also { busca = it }
        val encontrados = mutableListOf<Kora>()
        var pendentes = enderecos.size
        for (endereco in enderecos) pool.execute {
            val kora = sondar(endereco)
            principal.post {
                if (minha != geracao) return@post
                pendentes--
                if (kora != null) {
                    encontrados += kora
                    achados.addView(botao(kora.nome, destaque = true) { abrir(kora) })
                }
                if (pendentes == 0) terminou(encontrados, motivo, escolher)
            }
        }
        pool.shutdown()
    }

    private fun terminou(encontrados: List<Kora>, motivo: String?, escolher: Boolean) {
        when {
            // Sem erro pendente para mostrar, um Kora só na rede não precisa de escolha.
            encontrados.size == 1 && motivo == null && !escolher -> abrir(encontrados[0])
            encontrados.isEmpty() -> situacao.text = (motivo?.let { "$it\n\n" } ?: "") +
                "Nenhum Kora encontrado nesta rede. No PC, abra Configurações → Celular e ligue a conexão, ou leia o QR code de Nova conexão."
            else -> situacao.text = (motivo?.let { "$it\n\n" } ?: "") + "Escolha o PC:"
        }
    }

    private fun sondar(host: String): Kora? = runCatching {
        val conexao = URL("http://$host:$PORTA/health").openConnection() as HttpURLConnection
        conexao.connectTimeout = CONECTAR_MS
        conexao.readTimeout = LER_MS
        try {
            if (conexao.responseCode != 200) return@runCatching null
            val saude = JSONObject(conexao.inputStream.bufferedReader().readText())
            if (saude.optString("app") != "kora") null else Kora(host, saude.optString("name").ifEmpty { host })
        } finally {
            conexao.disconnect()
        }
    }.getOrNull()

    private fun ipDoCelular(): String? {
        val rede = getSystemService(ConnectivityManager::class.java)
        val ligacao = rede.getLinkProperties(rede.activeNetwork) ?: return null
        return ligacao.linkAddresses.map { it.address }.filterIsInstance<Inet4Address>().firstOrNull { !it.isLoopbackAddress }?.hostAddress
    }

    private fun lerQrCode() {
        val opcoes = GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build()
        GmsBarcodeScanning.getClient(this, opcoes).startScan()
            .addOnSuccessListener { codigo ->
                val convite = codigo.rawValue?.let(::lerConvite)
                if (convite == null) mostrarInicio("Esse QR code não é do Kora. No PC, use Configurações → Celular → Nova conexão.")
                else {
                    mostrarAbertura()
                    Thread {
                        val kora = sondar(convite.host) ?: Kora(convite.host, "PC")
                        principal.post { abrir(kora, convite.codigo) }
                    }.start()
                }
            }
            .addOnFailureListener { erro -> mostrarInicio("Não deu para ler o QR code: ${erro.message}") }
    }

    private fun dp(valor: Int) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, valor.toFloat(), resources.displayMetrics).toInt()

    private fun botao(texto: String, destaque: Boolean = false, aoTocar: () -> Unit) = Button(this).apply {
        text = texto
        isAllCaps = false
        textSize = 15f
        gravity = Gravity.START or Gravity.CENTER_VERTICAL
        setTextColor(if (destaque) FUNDO else TEXTO)
        background = GradientDrawable().apply {
            cornerRadius = dp(8).toFloat()
            setColor(if (destaque) AMBAR else CARTAO)
        }
        setPadding(dp(16), dp(12), dp(16), dp(12))
        layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(10) }
        setOnClickListener { aoTocar() }
    }

    private fun criarAbertura(): View {
        val logo = ImageView(this).apply { setImageResource(R.drawable.ic_launcher_foreground) }
        ObjectAnimator.ofFloat(logo, View.ALPHA, 1f, 0.4f).apply {
            duration = 700
            repeatMode = ValueAnimator.REVERSE
            repeatCount = ValueAnimator.INFINITE
            start()
        }
        return FrameLayout(this).apply {
            setBackgroundColor(FUNDO)
            isClickable = true
            addView(logo, FrameLayout.LayoutParams(dp(160), dp(160), Gravity.CENTER))
        }
    }

    private fun criarInicio(): View {
        situacao = TextView(this).apply {
            setTextColor(APAGADO)
            textSize = 14f
            setLineSpacing(0f, 1.3f)
            setPadding(0, dp(12), 0, dp(8))
        }
        achados = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val coluna = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(48), dp(24), dp(24))
            addView(ImageView(context).apply {
                setImageResource(R.drawable.wordmark)
                contentDescription = "Kora"
            }, LinearLayout.LayoutParams(dp(101), dp(56)).apply { bottomMargin = dp(20) })
            addView(TextView(context).apply {
                text = "Conectar ao seu PC"
                setTextColor(TEXTO)
                textSize = 22f
                typeface = Typeface.DEFAULT_BOLD
            })
            addView(TextView(context).apply {
                text = "Use as sessões do Kora no celular, na mesma rede Wi-Fi do PC."
                setTextColor(APAGADO)
                textSize = 14f
                setPadding(0, dp(6), 0, 0)
            })
            addView(situacao)
            addView(achados)
            addView(botao("Procurar de novo") { procurar() })
            addView(botao("Ler QR code do PC") { lerQrCode() })
        }
        return ScrollView(this).apply {
            setBackgroundColor(FUNDO)
            addView(coluna)
        }
    }
}
