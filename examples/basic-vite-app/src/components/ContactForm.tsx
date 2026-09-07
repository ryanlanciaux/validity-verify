import { useState } from 'react';

/**
 * A minimal contact form — the canonical target for a Validity *spec* with
 * hard-tier checks (fill the email, click Send, expect a POST to /api/contact,
 * expect no console errors). Built to be accessible: the email input has an
 * associated <label> so `getByRole('textbox', { name: 'Email' })` resolves,
 * and the submit control is a real <button> named "Send".
 */
export default function ContactForm() {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus('sending');
    try {
      const res = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      setStatus(res.ok ? 'sent' : 'error');
    } catch {
      setStatus('error');
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="contact-form"
      style={{ display: 'grid', gap: 12, maxWidth: 360 }}
    >
      <h2>Contact us</h2>
      <label style={{ display: 'grid', gap: 4 }}>
        Email
        <input
          type="email"
          name="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          required
        />
      </label>
      <button type="submit">Send</button>
      {status === 'sent' && <p role="status">Message sent — we'll be in touch.</p>}
      {status === 'error' && <p role="alert">Something went wrong. Try again.</p>}
    </form>
  );
}
