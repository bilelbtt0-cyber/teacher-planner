/**
 * Email relay for the Planner: lets the online app send reminder emails from a Gmail account.
 *
 * Setup (once, about 5 minutes):
 *  1. Sign in to the Gmail account that should send the reminders, open https://script.google.com
 *     and create a "New project". Replace everything in the editor with this file.
 *  2. Put the same long secret as the app's EMAIL_RELAY_SECRET below, then Save.
 *  3. Deploy → New deployment → type "Web app" → Execute as: "Me" → Who has access: "Anyone" → Deploy.
 *     Allow the permission ("Send email as you"). If Google shows "unverified app":
 *     Advanced → Go to (project name).
 *  4. Copy the Web app URL into the app's EMAIL_RELAY_URL.
 *
 * Only requests carrying the secret are accepted. Gmail allows about 100 emails a day this way.
 */
const SECRET = 'PASTE-THE-SAME-SECRET-AS-EMAIL_RELAY_SECRET';

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    if (data.secret !== SECRET) return reply({ ok: false, error: 'Unauthorized' });
    if (!data.to || !data.subject) return reply({ ok: false, error: 'Missing recipient or subject' });
    MailApp.sendEmail({
      to: data.to,
      subject: data.subject,
      body: data.text || data.subject,
      htmlBody: data.html || undefined,
      name: data.fromName || 'Planner',
    });
    return reply({ ok: true, remaining: MailApp.getRemainingDailyQuota() });
  } catch (err) {
    return reply({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

// Opening the URL in a browser shows that the relay is online.
function doGet() {
  return reply({ ok: true, relay: 'planner', remaining: MailApp.getRemainingDailyQuota() });
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
