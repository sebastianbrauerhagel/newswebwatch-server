// Builds and sends the Teams Adaptive Card. Payload mirrors the original /api/notify
// handler so the Power Automate Workflow keeps working unchanged.

function buildCard(msg) {
  const issuer = msg.issuerSign || '';
  const issuerName = msg.issuerName || '';
  const title = msg.title || '–';
  const category = msg.category || '';
  const time = msg.publishedTime || '';
  const msgUrl = msg.messageId
    ? `https://newsweb.oslobors.no/message/${msg.messageId}`
    : 'https://newsweb.oslobors.no';

  return {
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.4',
    body: [
      {
        type: 'TextBlock',
        text: `📰 ${issuer}${issuerName ? ` · ${issuerName}` : ''}`,
        weight: 'Bolder',
        color: 'Attention',
        size: 'Small',
      },
      { type: 'TextBlock', text: title, wrap: true, weight: 'Bolder', size: 'Medium' },
      {
        type: 'TextBlock',
        text: `${category ? `${category} · ` : ''}${time}`,
        isSubtle: true,
        size: 'Small',
      },
    ],
    actions: [{ type: 'Action.OpenUrl', title: 'Åpne på NewsWeb', url: msgUrl }],
  };
}

// Sends the card to a single webhook. Returns { ok, status, error }.
export async function sendToTeams(webhookUrl, msg) {
  const payload = buildCard(msg);
  try {
    const r = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    // Drain the body so the connection is freed; Power Automate returns 202 with no/short body.
    const text = await r.text().catch(() => '');
    return { ok: r.ok, status: r.status, error: r.ok ? null : text.slice(0, 500) };
  } catch (err) {
    return { ok: false, status: null, error: err.message };
  }
}
