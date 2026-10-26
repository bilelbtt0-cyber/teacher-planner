// "It wasn't me" page, opened from the new sign-in email: signs every device out.
// The one-time token is in the address after #, so it never reaches server logs.
const TEXT = {
  fr: {
    title: 'Ce n’était pas vous ?',
    explain: 'Nous allons déconnecter tous les appareils connectés à votre agenda, y compris celui-ci. Vous devrez ensuite vous reconnecter et choisir un nouveau mot de passe.',
    button: 'Déconnecter tous les appareils',
    cancel: 'Annuler, c’était bien moi',
    doneTitle: 'C’est fait',
    doneText: 'Tous les appareils ont été déconnectés. Reconnectez-vous, puis changez votre mot de passe dans Paramètres → Moi. Si vous ne le connaissez plus, utilisez « Mot de passe oublié ? ».',
    signIn: 'Me reconnecter',
    expired: 'Ce lien a expiré ou a déjà été utilisé. Si vous pensez que quelqu’un utilise votre compte, changez votre mot de passe.',
    failed: 'Impossible de joindre l’application. Réessayez dans un instant.',
  },
  en: {
    title: 'Wasn’t you?',
    explain: 'We will sign out every device connected to your planner, including this one. You will then sign in again and choose a new password.',
    button: 'Sign out every device',
    cancel: 'Cancel, it was me',
    doneTitle: 'Done',
    doneText: 'Every device was signed out. Sign in again, then change your password in Settings → Me. If you no longer know it, use “Forgot your password?”.',
    signIn: 'Sign in again',
    expired: 'This link has expired or was already used. If you think someone is using your account, change your password.',
    failed: 'Cannot reach the app. Please try again in a moment.',
  },
};
const lang = navigator.language && navigator.language.toLowerCase().startsWith('fr') ? 'fr' : 'en';
const t = TEXT[lang];
document.documentElement.lang = lang;
document.title = t.title;
for (const el of document.querySelectorAll('[data-t]')) el.textContent = t[el.dataset.t];

const token = location.hash.slice(1);
history.replaceState(null, '', location.pathname);
const err = document.getElementById('err');
const go = document.getElementById('go');
if (!/^[0-9a-f]{64}$/.test(token)) {
  go.hidden = true;
  err.textContent = t.expired;
  err.hidden = false;
}
go.addEventListener('click', async () => {
  go.disabled = true;
  err.hidden = true;
  try {
    const res = await fetch('/api/auth/revoke', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
    if (!res.ok) throw new Error(res.status === 400 ? 'expired' : 'failed');
    document.getElementById('ask').hidden = true;
    document.getElementById('done').hidden = false;
  } catch (e) {
    err.textContent = e.message === 'expired' ? t.expired : t.failed;
    err.hidden = false;
    go.disabled = false;
  }
});
