import type { Mailer } from './accounts.ts'

// Resend pela API HTTP, sem SDK: um POST com HTML e texto. Falha ou demora vira erro, e quem pediu o código vê que o
// e-mail não saiu (em vez de esperar um código que nunca chega).
export function resendMailer(apiKey: string, from: string): Mailer {
  return {
    async send(to, email) {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from, to: [to], subject: email.subject, html: email.html, text: email.text }),
        signal: AbortSignal.timeout(10_000)
      })
      if (!response.ok) throw new Error(`Resend respondeu ${response.status}: ${(await response.text()).slice(0, 200)}`)
    }
  }
}
