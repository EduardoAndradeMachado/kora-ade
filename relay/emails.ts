// E-mails da conta do Fora de casa. HTML de e-mail: tabelas e estilo inline, porque Gmail e Outlook ignoram quase todo
// CSS moderno e nenhum dos dois mostra SVG (o logotipo vai em PNG). Cada e-mail sai também em texto puro.

export type EmailKind = 'verify' | 'reset'

export interface Email {
  subject: string
  html: string
  text: string
}

export interface EmailOptions {
  code: string
  minutes: number
  logoUrl: string
}

const COPY: Record<EmailKind, { subject: string; title: string; lead: string; ignore: string }> = {
  verify: {
    subject: 'Confirme seu e-mail no Kora',
    title: 'Confirme seu e-mail',
    lead: 'Digite este código no Kora do seu PC para ativar o acesso fora de casa.',
    ignore: 'Não foi você? Ignore este e-mail: sem o código, nenhuma conta é criada.'
  },
  reset: {
    subject: 'Redefinição de senha do Kora',
    title: 'Redefina sua senha',
    lead: 'Pediram para redefinir a senha da conta do Kora ligada a este e-mail. Digite este código no Kora do seu PC.',
    ignore: 'Não foi você? Ignore este e-mail: sua senha continua a mesma.'
  }
}

const escape = (value: string): string =>
  value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)

// "482913" → "482 913": mais fácil de ler e de copiar olhando para o celular.
const spaced = (code: string): string => (code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code)

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
const MONO = "'SFMono-Regular', 'Cascadia Mono', Consolas, 'Liberation Mono', monospace"

export function renderEmail(kind: EmailKind, options: EmailOptions): Email {
  const copy = COPY[kind]
  const code = escape(spaced(options.code))
  const validity = `O código vale por ${options.minutes} minutos e só pode ser usado uma vez.`
  const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escape(copy.subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f1ec;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escape(copy.lead)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f1ec;">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;background:#ffffff;border:1px solid #e7e1d8;border-radius:12px;">
<tr><td style="padding:32px 32px 8px;">
<img src="${escape(options.logoUrl)}" width="88" height="48" alt="kora" style="display:block;border:0;outline:none;">
</td></tr>
<tr><td style="padding:16px 32px 0;font-family:${FONT};">
<h1 style="margin:0 0 12px;font-size:22px;line-height:28px;font-weight:600;color:#1c1917;">${escape(copy.title)}</h1>
<p style="margin:0;font-size:15px;line-height:22px;color:#44403c;">${escape(copy.lead)}</p>
</td></tr>
<tr><td style="padding:24px 32px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#fbf6ee;border:1px solid #f0dfc6;border-radius:10px;">
<tr><td align="center" style="padding:20px 12px;font-family:${MONO};font-size:34px;line-height:40px;font-weight:600;letter-spacing:6px;color:#1c1917;">${code}</td></tr>
</table>
<p style="margin:12px 0 0;font-family:${FONT};font-size:13px;line-height:20px;color:#78716c;text-align:center;">${escape(validity)}</p>
</td></tr>
<tr><td style="padding:0 32px 28px;font-family:${FONT};">
<p style="margin:0;padding-top:20px;border-top:1px solid #efeae3;font-size:13px;line-height:20px;color:#78716c;">${escape(copy.ignore)} Ninguém do Kora vai pedir este código para você.</p>
</td></tr>
</table>
<p style="margin:16px 0 0;font-family:${FONT};font-size:12px;line-height:18px;color:#a8a29e;">Kora · seus agentes, do PC para o celular</p>
</td></tr>
</table>
</body>
</html>
`
  const text = [
    copy.title,
    '',
    copy.lead,
    '',
    `    ${spaced(options.code)}`,
    '',
    validity,
    '',
    `${copy.ignore} Ninguém do Kora vai pedir este código para você.`
  ].join('\n')
  return { subject: copy.subject, html, text }
}
