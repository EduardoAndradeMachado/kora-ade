package br.com.eduardom.kora

import android.Manifest
import android.animation.ObjectAnimator
import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.media.MediaRecorder
import android.net.Uri
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.ConnectivityManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Base64
import android.text.InputFilter
import android.text.TextUtils
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
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.PopupMenu
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
import kotlin.math.log10
import kotlin.math.roundToInt

private const val TAG = "kora"
// Endereço do único PC das versões antigas do app; só é lido para migrar para a lista.
private const val HOST_ANTIGO = "host"
private const val PCS_SALVOS = "pcs"
private const val ULTIMO_PC = "ultimo"
private const val FUNDO = 0xFF16171B.toInt()
private const val TEXTO = 0xFFF3E6D0.toInt()
private const val APAGADO = 0xFF9A9CA5.toInt()
private const val AMBAR = 0xFFD98E3A.toInt()
private const val CARTAO = 0xFF22242A.toInt()
private const val VERDE = 0xFF4CAF7A.toInt()
private const val DESLIGADO = 0xFF55575F.toInt()

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
    private lateinit var conteudo: LinearLayout
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

    // Microfone do campo de mensagem (src/renderer/src/mobile/voice.ts): a página não abre o microfone em HTTP, então o app grava
    // e devolve o áudio por window.koraAudio.
    private var gravador: MediaRecorder? = null
    private var gravacao: File? = null
    private var inicioDaGravacao = 0L
    // Nível do microfone para as barras do campo: quem fala vê que o áudio está chegando.
    private val medirNivel = object : Runnable {
        override fun run() {
            val ativo = gravador ?: return
            // maxAmplitude é o pico desde a leitura anterior, de 0 a 32767. Em decibéis, a fala fica entre -40 e -10:
            // a escala de -50 a 0 deixa o silêncio embaixo e a voz no meio das barras.
            val pico = ativo.maxAmplitude
            val nivel = if (pico <= 0) 0.0 else ((20 * log10(pico / 32767.0) + 50) / 50).coerceIn(0.0, 1.0)
            avisarAudio(JSONObject().put("tipo", "nivel").put("valor", (nivel * 100).roundToInt() / 100.0))
            principal.postDelayed(this, 80)
        }
    }
    // Liberar o microfone não começa a gravar: a pessoa ainda nem viu que já pode falar.
    private val pedirMicrofone = registerForActivityResult(ActivityResultContracts.RequestPermission()) { liberado ->
        avisarAudio(JSONObject().put("tipo", "erro").put("mensagem",
            if (liberado) "Microfone liberado. Toque de novo para gravar."
            else "Sem o microfone, o app não grava. Libere o microfone do Kora nas configurações do Android."))
    }

    private val preferencias by lazy { getSharedPreferences("kora", MODE_PRIVATE) }
    private var busca: ExecutorService? = null
    // Cada busca nova invalida as respostas atrasadas da anterior.
    private var geracao = 0
    private var atual: Kora? = null
    private var pcs: List<PcSalvo>
        get() = lerPcs(preferencias.getString(PCS_SALVOS, null))
        set(lista) = preferencias.edit().putString(PCS_SALVOS, escreverPcs(lista)).apply()
    private fun exibido(kora: Kora): String = pcs.find { it.id == kora.id }?.exibido ?: kora.nome
    // Tela de PCs (nativa, a mesma com qualquer versão do Kora no PC): a lista, o Adicionar PC e o passo a passo
    // do pareamento.
    private enum class Tela { PCS, ADICIONAR, PAREAR }
    private var tela = Tela.PCS
    private var parearCom = ""
    private var aviso: String? = null
    // Resultado da última busca: id ausente em respostas é PC salvo que ainda não respondeu.
    private val respostas = mutableMapOf<String, Boolean>()
    private val pareados = mutableMapOf<String, Boolean?>()
    private val naRede = mutableListOf<Kora>()
    private var buscando = false
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
                when {
                    web.visibility == View.VISIBLE && web.canGoBack() -> web.goBack()
                    inicio.visibility == View.VISIBLE && tela != Tela.PCS && pcs.isNotEmpty() -> mudarTela(Tela.PCS)
                    // Abriu a lista de PCs e desistiu de trocar: volta para o PC em que estava.
                    inicio.visibility == View.VISIBLE && atual != null -> voltarParaPagina()
                    else -> finish()
                }
            }
        })

        // Até decidir o que mostrar, só a logo: nada de telas piscando enquanto o app procura o PC.
        val ultimo = pcs.find { it.id == preferencias.getString(ULTIMO_PC, null) }
        val antigo = preferencias.getString(HOST_ANTIGO, null)
        if (ultimo == null && antigo == null) procurar(automatico = true) else {
            mostrarAbertura()
            Thread {
                val kora = if (ultimo != null) sondar(ultimo.host, ultimo.porta)?.takeIf { conhecido(listOf(ultimo), it) }
                else PORTAS.firstNotNullOfOrNull { sondar(antigo!!, it) }
                val pareado = kora?.let(::pareado)
                principal.post { if (kora != null && pareado != false) abrir(kora) else procurar() }
            }.start()
        }
    }

    override fun onPause() {
        super.onPause()
        CookieManager.getInstance().flush()
    }

    override fun onStop() {
        super.onStop()
        pararGravacao(enviar = false)
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
        fun escolherPc() = runOnUiThread {
            tela = Tela.PCS
            procurar()
        }

        @JavascriptInterface
        fun pronto() = runOnUiThread { mostrarPagina() }

        @JavascriptInterface
        fun versao(): String = packageManager.getPackageInfo(packageName, 0).versionName.orEmpty()

        @JavascriptInterface
        fun buscarAtualizacao() = runOnUiThread { atual?.let { conferirVersao(it, pedida = true) } }

        @JavascriptInterface
        fun gravarAudio() = runOnUiThread { comecarGravacao() }

        @JavascriptInterface
        fun pararAudio(enviar: Boolean) = runOnUiThread { pararGravacao(enviar) }
    }

    private fun avisarAudio(evento: JSONObject) = web.evaluateJavascript("window.koraAudio && window.koraAudio($evento)", null)

    private fun comecarGravacao() {
        if (gravador != null) return
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            pedirMicrofone.launch(Manifest.permission.RECORD_AUDIO)
            return
        }
        val pasta = File(cacheDir, "audio").apply { mkdirs() }
        // Gravação que ficou para trás (app fechado no meio do envio) sai aqui.
        pasta.listFiles()?.forEach { it.delete() }
        val arquivo = File(pasta, "fala-${System.nanoTime()}.ogg")
        val novo = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) MediaRecorder(this) else @Suppress("DEPRECATION") MediaRecorder()
        // Opus mono a 16 kHz: o Whisper do Transcritor ouve a 16 kHz, e 24 kbps basta para voz.
        val iniciou = runCatching {
            novo.setAudioSource(MediaRecorder.AudioSource.VOICE_RECOGNITION)
            novo.setOutputFormat(MediaRecorder.OutputFormat.OGG)
            novo.setAudioEncoder(MediaRecorder.AudioEncoder.OPUS)
            novo.setAudioChannels(1)
            novo.setAudioSamplingRate(16_000)
            novo.setAudioEncodingBitRate(24_000)
            novo.setOutputFile(arquivo)
            novo.prepare()
            novo.start()
        }
        if (iniciou.isFailure) {
            Log.w(TAG, "falha ao abrir o microfone", iniciou.exceptionOrNull())
            novo.release()
            arquivo.delete()
            avisarAudio(JSONObject().put("tipo", "erro").put("mensagem", "Não deu para abrir o microfone. Outro app pode estar usando."))
            return
        }
        gravador = novo
        gravacao = arquivo
        inicioDaGravacao = SystemClock.elapsedRealtime()
        avisarAudio(JSONObject().put("tipo", "gravando"))
        principal.postDelayed(medirNivel, 80)
    }

    private fun pararGravacao(enviar: Boolean) {
        val parado = gravador ?: return
        val arquivo = gravacao!!
        gravador = null
        gravacao = null
        principal.removeCallbacks(medirNivel)
        val curta = SystemClock.elapsedRealtime() - inicioDaGravacao < 500
        // stop() lança quando ainda não houve áudio nenhum (toque rápido): conta como gravação curta.
        val gravou = runCatching { parado.stop() }.isSuccess
        parado.release()
        if (!enviar || curta || !gravou) {
            arquivo.delete()
            avisarAudio(JSONObject().put("tipo", if (enviar) "curto" else "cancelado"))
            return
        }
        Thread {
            val audio = runCatching { Base64.encodeToString(arquivo.readBytes(), Base64.NO_WRAP) }
            arquivo.delete()
            principal.post {
                avisarAudio(audio.fold(
                    { JSONObject().put("tipo", "audio").put("mime", "audio/ogg").put("base64", it) },
                    { JSONObject().put("tipo", "erro").put("mensagem", "Não deu para ler a gravação no celular.") }
                ))
            }
        }.start()
    }

    private inner class Cliente : WebViewClient() {
        // Só a página do Kora roda dentro do app (a ponte KoraApp fica exposta a ela); link de fora vai para o navegador.
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            // /raw/ é um arquivo do projeto (o Abrir página inteira do HTML): vai para o navegador, que tem zoom e
            // carrega a página inteira; o resto do Kora fica dentro do app.
            val doKora = request.url.host == atual?.host && request.url.port == atual?.porta
            // Só a página principal: um link dentro da prévia do HTML (iframe) navega dentro dela.
            if (doKora && (!request.isForMainFrame || request.url.path?.startsWith("/raw/") != true)) return false
            runCatching { startActivity(Intent(Intent.ACTION_VIEW, request.url)) }
            return true
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (!request.isForMainFrame) return
            Log.w(TAG, "falha ao abrir ${request.url}: ${error.errorCode} ${error.description}")
            val motivo = "Não consegui abrir o Kora${atual?.let { " do PC ${exibido(it)}" } ?: ""}. O PC está ligado, com a conexão do celular ativa?"
            atual = null
            tela = Tela.PCS
            procurar(motivo)
        }
    }

    private fun abrir(kora: Kora, codigo: String? = null) {
        atual = kora
        pcs = lembrar(pcs, kora)
        preferencias.edit().putString(ULTIMO_PC, kora.id).remove(HOST_ANTIGO).apply()
        busca?.shutdownNow()
        val minha = ++geracao
        mostrarAbertura()
        // A página carrega por baixo da logo e só aparece quando avisa (KoraApp.pronto) que tem o que mostrar.
        web.visibility = View.INVISIBLE
        // A query força uma navegação nova: só trocar o #pair numa página já aberta não a recarregaria.
        web.loadUrl(if (codigo == null) "http://${kora.host}:${kora.porta}/" else "http://${kora.host}:${kora.porta}/?convite=${System.currentTimeMillis()}#pair=$codigo")
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
        atual?.let { conferirVersao(it) }
    }

    private fun voltarParaPagina() {
        busca?.shutdownNow()
        ++geracao
        inicio.visibility = View.GONE
        abertura.visibility = View.GONE
        web.visibility = View.VISIBLE
    }

    // Entrar num PC da lista: confere de novo, porque o PC pode ter desligado ou desfeito o pareamento desde a busca.
    private fun entrar(salvo: PcSalvo) {
        if (salvo.id == atual?.id) return voltarParaPagina()
        mostrarAbertura()
        Thread {
            val kora = sondar(salvo.host, salvo.porta)?.takeIf { conhecido(listOf(salvo), it) }
            val pareado = kora?.let(::pareado)
            principal.post {
                when {
                    kora == null -> procurar("O ${salvo.exibido} não respondeu. No PC, o Kora precisa estar aberto, com a conexão do celular ligada (Configurações → Celular).")
                    pareado == false -> parear(salvo.exibido)
                    else -> abrir(kora)
                }
            }
        }.start()
    }

    private fun parear(nome: String) {
        parearCom = nome
        aviso = null
        mudarTela(Tela.PAREAR)
    }

    private fun mudarTela(nova: Tela) {
        tela = nova
        mostrarInicio()
    }

    // O instalador do Kora do PC leva o APK junto: quando o PC se atualiza pelo GitHub, o app se atualiza por ele.
    // pedida: a pessoa tocou em Buscar atualização, então a resposta aparece mesmo quando não há versão nova.
    private fun conferirVersao(kora: Kora, pedida: Boolean = false) {
        if (!versaoConferida.add(kora.id) && !pedida) return
        val instalada = packageManager.getPackageInfo(packageName, 0).longVersionCode
        Thread {
            val consulta = runCatching {
                val conexao = URL("http://${kora.host}:${kora.porta}/app/android.json").openConnection() as HttpURLConnection
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
                    .setPositiveButton("Atualizar") { _, _ -> baixarAtualizacao(kora) }
                    .setNegativeButton("Depois", null)
                    .show()
            }
        }.start()
    }

    private fun baixarAtualizacao(kora: Kora) {
        Toast.makeText(this, "Baixando a atualização do PC…", Toast.LENGTH_SHORT).show()
        Thread {
            val arquivo = runCatching {
                val pasta = File(cacheDir, "atualizacao").apply { mkdirs() }
                val destino = File(pasta, "kora.apk")
                val conexao = URL("http://${kora.host}:${kora.porta}/app/kora-celular.apk").openConnection() as HttpURLConnection
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

    private fun mostrarInicio() {
        inicio.visibility = View.VISIBLE
        abertura.visibility = View.GONE
        web.visibility = View.GONE
        renderizar()
    }

    // automatico: o app acabou de abrir sem PC salvo; achando um Kora só na rede, não há o que escolher.
    private fun procurar(aviso: String? = null, automatico: Boolean = false) {
        respostas.clear()
        pareados.clear()
        naRede.clear()
        val ip = ipDoCelular()
        buscando = ip != null
        this.aviso = aviso ?: if (ip == null) "Conecte o celular ao Wi-Fi de casa para achar o Kora do PC." else null
        mostrarInicio()
        if (ip == null) return
        val minha = ++geracao
        busca?.shutdownNow()
        // Os salvos primeiro, para o estado deles aparecer logo; depois as duas portas de cada vizinho (o Kora
        // instalado e o Kora Dev podem estar ligados no mesmo PC).
        val enderecos = (pcs.map { it.host to it.porta } + vizinhos(ip).flatMap { host -> PORTAS.map { host to it } }).distinct()
        val pool = Executors.newFixedThreadPool(SONDAS_EM_PARALELO).also { busca = it }
        var pendentes = enderecos.size
        for ((host, porta) in enderecos) pool.execute {
            val kora = sondar(host, porta)
            val pareado = kora?.let(::pareado)
            principal.post {
                if (minha != geracao) return@post
                pendentes--
                if (kora != null) achou(kora, pareado)
                if (pendentes == 0) terminou(automatico)
            }
        }
        pool.shutdown()
    }

    private fun achou(kora: Kora, pareado: Boolean?) {
        pareados[kora.id] = pareado
        if (conhecido(pcs, kora)) {
            val antigo = "${kora.host}:${kora.porta}"
            if (preferencias.getString(ULTIMO_PC, null) == antigo) preferencias.edit().putString(ULTIMO_PC, kora.id).apply()
            pcs = lembrar(pcs, kora)
            respostas[kora.id] = true
        } else if (naRede.none { it.id == kora.id }) naRede += kora
        renderizar()
    }

    private fun terminou(automatico: Boolean) {
        buscando = false
        for (pc in pcs) respostas.putIfAbsent(pc.id, false)
        if (automatico && pcs.isEmpty() && naRede.size == 1) return tocarNaRede(naRede[0])
        renderizar()
    }

    // Kora da rede que ainda não está na lista: entra se o celular já tem pareamento com ele, senão vai ao passo a passo.
    private fun tocarNaRede(kora: Kora) {
        if (pareados[kora.id] == false) parear(kora.nome) else abrir(kora)
    }

    private fun tocar(pc: PcSalvo) {
        if (situacao(respostas[pc.id], pareados[pc.id]) == Situacao.PRECISA_PAREAR) parear(pc.exibido) else entrar(pc)
    }

    private fun renderizar() {
        conteudo.removeAllViews()
        // Sem PC salvo, a primeira tela já é a de adicionar, sem "voltar".
        when (if (tela == Tela.PCS && pcs.isEmpty()) Tela.ADICIONAR else tela) {
            Tela.PCS -> telaPcs()
            Tela.ADICIONAR -> telaAdicionar()
            Tela.PAREAR -> telaParear()
        }
    }

    private fun telaPcs() {
        val atualizar = TextView(this).apply {
            text = "↻"
            textSize = 22f
            setTextColor(if (buscando) DESLIGADO else APAGADO)
            gravity = Gravity.CENTER
            contentDescription = "Atualizar a lista"
            isEnabled = !buscando
            setOnClickListener { procurar() }
        }
        conteudo.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            addView(titulo("Seus PCs"), LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
            addView(atualizar, LinearLayout.LayoutParams(dp(48), dp(48)))
        })
        texto(aviso)
        for (pc in pcs) conteudo.addView(linhaPc(pc))
        conteudo.addView(botao("+  Adicionar PC", espaco = 18) { mudarTela(Tela.ADICIONAR) })
    }

    private fun telaAdicionar() {
        val primeira = pcs.isEmpty()
        conteudo.addView(titulo(if (primeira) "Conectar ao seu PC" else "Adicionar PC"))
        texto(aviso ?: "No PC, o Kora precisa estar aberto, com a conexão do celular ligada (Configurações → Celular).")
        secao(if (buscando) "PROCURANDO NA SUA REDE…" else "NA SUA REDE")
        for (kora in naRede) conteudo.addView(linhaNaRede(kora))
        if (!buscando && naRede.isEmpty()) texto("Nenhum PC novo nesta rede. Se o seu não aparecer, leia o QR code dele.")
        conteudo.addView(botao("Ler QR code de um PC", principal = true, espaco = 22) { lerQrCode() })
        if (!primeira) conteudo.addView(botao("Voltar para os PCs") { mudarTela(Tela.PCS) })
    }

    private fun telaParear() {
        conteudo.addView(titulo("Parear com $parearCom"))
        texto(aviso ?: "Este celular ainda não tem acesso a este PC. É só uma vez:")
        conteudo.addView(TextView(this).apply {
            text = "1.  No PC, abra Configurações → Celular → Nova conexão.\n2.  Toque em Ler QR code e aponte para o código que aparece no PC."
            setTextColor(TEXTO)
            textSize = 15f
            setLineSpacing(0f, 1.4f)
            setPadding(0, dp(14), 0, 0)
        })
        conteudo.addView(botao("Ler QR code", principal = true, espaco = 22) { lerQrCode() })
        conteudo.addView(botao("Voltar para os PCs") { mudarTela(Tela.PCS) })
    }

    private fun titulo(texto: String) = TextView(this).apply {
        text = texto
        setTextColor(TEXTO)
        textSize = 22f
        typeface = Typeface.DEFAULT_BOLD
    }

    private fun texto(texto: String?) {
        if (texto == null) return
        conteudo.addView(TextView(this).apply {
            text = texto
            setTextColor(APAGADO)
            textSize = 14f
            setLineSpacing(0f, 1.3f)
            setPadding(0, dp(8), 0, 0)
        })
    }

    private fun secao(texto: String) {
        conteudo.addView(TextView(this).apply {
            text = texto
            setTextColor(APAGADO)
            textSize = 12f
            letterSpacing = 0.08f
            setPadding(0, dp(24), 0, 0)
        })
    }

    private fun linhaPc(pc: PcSalvo): View {
        val estado = situacao(respostas[pc.id], pareados[pc.id])
        val cor = when (estado) {
            Situacao.PRONTO -> VERDE
            Situacao.PRECISA_PAREAR -> AMBAR
            Situacao.DESLIGADO -> DESLIGADO
            Situacao.PROCURANDO -> APAGADO
        }
        val mais = TextView(this).apply {
            text = "⋯"
            minWidth = dp(48)
            textSize = 22f
            setTextColor(APAGADO)
            gravity = Gravity.CENTER
            contentDescription = "Opções de ${pc.exibido}"
            setOnClickListener { opcoes(this, pc) }
        }
        return linha(pc.exibido, "${pc.tipo} · ${estado.rotulo}", cor, if (pc.id == atual?.id) "Em uso" else null, mais) { tocar(pc) }
    }

    private fun linhaNaRede(kora: Kora): View {
        val tipo = if (kora.edicao == "dev") "Kora Dev" else "Kora"
        val acao = TextView(this).apply {
            text = if (pareados[kora.id] == false) "Parear" else "Entrar"
            textSize = 14f
            setTextColor(AMBAR)
            gravity = Gravity.CENTER
            setPadding(dp(8), 0, dp(4), 0)
        }
        return linha(kora.nome, "$tipo · ${kora.host}", VERDE, null, acao) { tocarNaRede(kora) }
    }

    private fun linha(nome: String, detalhe: String, cor: Int, marca: String?, fim: View, aoTocar: () -> Unit): View {
        val ponto = View(this).apply { background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(cor) } }
        val textos = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(TextView(context).apply {
                text = nome
                textSize = 16f
                setTextColor(TEXTO)
                typeface = Typeface.DEFAULT_BOLD
                maxLines = 1
                ellipsize = TextUtils.TruncateAt.END
            })
            addView(TextView(context).apply {
                text = detalhe
                textSize = 13f
                setTextColor(APAGADO)
                maxLines = 1
                ellipsize = TextUtils.TruncateAt.END
            })
        }
        return LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            minimumHeight = dp(64)
            setPadding(dp(16), dp(10), dp(4), dp(10))
            background = GradientDrawable().apply {
                cornerRadius = dp(10).toFloat()
                setColor(CARTAO)
                if (marca != null) setStroke(dp(1), AMBAR)
            }
            layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(10) }
            isClickable = true
            setOnClickListener { aoTocar() }
            addView(ponto, LinearLayout.LayoutParams(dp(10), dp(10)).apply { marginEnd = dp(14) })
            addView(textos, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
            if (marca != null) addView(TextView(context).apply {
                text = marca
                textSize = 12f
                setTextColor(AMBAR)
                setPadding(dp(8), 0, 0, 0)
            })
            addView(fim, LinearLayout.LayoutParams(WRAP_CONTENT, dp(48)))
        }
    }

    // Pergunta ao PC se o cookie deste celular ainda vale. Vale também com Kora antigo, que já tinha /api/device.
    private fun pareado(kora: Kora): Boolean? = runCatching {
        val endereco = "http://${kora.host}:${kora.porta}"
        val conexao = URL("$endereco/api/device").openConnection() as HttpURLConnection
        CookieManager.getInstance().getCookie(endereco)?.let { conexao.setRequestProperty("Cookie", it) }
        conexao.connectTimeout = CONECTAR_MS
        conexao.readTimeout = LER_MS
        try { pareadoPelaResposta(conexao.responseCode) } finally { conexao.disconnect() }
    }.getOrNull()

    private fun opcoes(ancora: View, pc: PcSalvo) {
        PopupMenu(this, ancora).apply {
            menu.add("Renomear").setOnMenuItemClickListener { pedirNome(pc); true }
            menu.add("Remover deste celular").setOnMenuItemClickListener { confirmarRemover(pc); true }
            show()
        }
    }

    private fun pedirNome(pc: PcSalvo) {
        val campo = EditText(this).apply {
            setText(pc.exibido)
            setSelection(text.length)
            isSingleLine = true
            hint = pc.nome
            filters = arrayOf(InputFilter.LengthFilter(60))
        }
        val moldura = FrameLayout(this).apply {
            setPadding(dp(20), dp(4), dp(20), 0)
            addView(campo)
        }
        AlertDialog.Builder(this)
            .setTitle("Renomear PC")
            .setMessage("Vale só neste celular. Vazio volta ao nome que o PC informa (${pc.nome}).")
            .setView(moldura)
            .setPositiveButton("Salvar") { _, _ ->
                pcs = renomear(pcs, pc.id, campo.text.toString())
                renderizar()
            }
            .setNegativeButton("Cancelar", null)
            .show()
    }

    private fun confirmarRemover(pc: PcSalvo) {
        AlertDialog.Builder(this)
            .setTitle("Remover ${pc.exibido}?")
            .setMessage("O celular deixa de ter acesso a este PC. Para usar de novo, é preciso parear com o QR code.")
            .setPositiveButton("Remover") { _, _ -> removerPc(pc) }
            .setNegativeButton("Cancelar", null)
            .show()
    }

    private fun removerPc(pc: PcSalvo) {
        val endereco = "http://${pc.host}:${pc.porta}"
        val cookies = CookieManager.getInstance()
        val enviados = cookies.getCookie(endereco)
        // O PC tira o celular dos pareados dele; desligado ou com Kora antigo, fica só a saída daqui.
        if (enviados != null) Thread {
            runCatching {
                val conexao = URL("$endereco/api/device").openConnection() as HttpURLConnection
                conexao.requestMethod = "DELETE"
                conexao.setRequestProperty("Cookie", enviados)
                conexao.connectTimeout = 2000
                conexao.readTimeout = 3000
                try { conexao.responseCode } finally { conexao.disconnect() }
            }.onFailure { Log.w(TAG, "o PC não recebeu a saída do celular", it) }
        }.start()
        for (nome in cookiesParaApagar(pcs, pc)) cookies.setCookie(endereco, "$nome=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT")
        cookies.flush()
        pcs = esquecer(pcs, pc.id)
        respostas.remove(pc.id)
        pareados.remove(pc.id)
        if (preferencias.getString(ULTIMO_PC, null) == pc.id) preferencias.edit().remove(ULTIMO_PC).apply()
        if (atual?.id == pc.id) {
            atual = null
            web.loadUrl("about:blank")
        }
        renderizar()
    }

    private fun sondar(host: String, porta: Int): Kora? = runCatching {
        val conexao = URL("http://$host:$porta/health").openConnection() as HttpURLConnection
        conexao.connectTimeout = CONECTAR_MS
        conexao.readTimeout = LER_MS
        try {
            if (conexao.responseCode != 200) return@runCatching null
            val saude = JSONObject(conexao.inputStream.bufferedReader().readText())
            if (saude.optString("app") != "kora") return@runCatching null
            // Kora de antes do id: o endereço vira o id, como era o único PC que o app guardava.
            val id = saude.optString("id").ifEmpty { "$host:$porta" }
            val edicao = saude.optString("edition")
            Kora(id, host, porta, nomeDoPc(saude.optString("name").ifEmpty { host }, edicao), edicao)
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
                if (convite == null) {
                    aviso = "Esse QR code não é do Kora. No PC, use Configurações → Celular → Nova conexão."
                    mostrarInicio()
                }
                else {
                    mostrarAbertura()
                    Thread {
                        val kora = sondar(convite.host, convite.porta) ?: Kora("${convite.host}:${convite.porta}", convite.host, convite.porta, "PC")
                        principal.post { abrir(kora, convite.codigo) }
                    }.start()
                }
            }
            .addOnFailureListener { erro ->
                aviso = "Não deu para ler o QR code: ${erro.message}"
                mostrarInicio()
            }
    }

    private fun dp(valor: Int) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, valor.toFloat(), resources.displayMetrics).toInt()

    private fun botao(texto: String, principal: Boolean = false, espaco: Int = 10, aoTocar: () -> Unit) = Button(this).apply {
        text = texto
        isAllCaps = false
        textSize = 15f
        gravity = if (principal) Gravity.CENTER else Gravity.START or Gravity.CENTER_VERTICAL
        setTextColor(if (principal) FUNDO else TEXTO)
        if (principal) typeface = Typeface.DEFAULT_BOLD
        background = GradientDrawable().apply {
            cornerRadius = dp(8).toFloat()
            setColor(if (principal) AMBAR else CARTAO)
        }
        setPadding(dp(16), dp(12), dp(16), dp(12))
        layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(espaco) }
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
        conteudo = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val coluna = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(48), dp(24), dp(24))
            addView(ImageView(context).apply {
                setImageResource(R.drawable.wordmark)
                contentDescription = "Kora"
            }, LinearLayout.LayoutParams(dp(101), dp(56)).apply { bottomMargin = dp(20) })
            addView(conteudo)
        }
        return ScrollView(this).apply {
            setBackgroundColor(FUNDO)
            addView(coluna)
        }
    }
}
