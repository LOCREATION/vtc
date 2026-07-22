// ============================================================
// LOC RÉACTION S.A.S — (chemin mis à jour)
// depth = 1 (client/wallet.html)
// ============================================================
import { supabase, requireAuth, logout, formatPrice, formatDateTime, formatInitials, showToast, hideLoader, getWallet, creditWallet } from '../../shared/supabase.js'
import { initAppHamburger } from '../../shared/app-nav.js'

initAppHamburger()

let currentUser = null
let currentWallet = null

async function init() {
  const user = await requireAuth(2, 'client')
  if (!user) return
  currentUser = user

  document.getElementById('nav-av').textContent = formatInitials(user.prenom, user.nom)
  document.getElementById('nav-nm').textContent = user.prenom + ' ' + user.nom
  document.getElementById('nav-rl').textContent = 'Client'
  document.getElementById('sb-av').textContent = formatInitials(user.prenom, user.nom)
  document.getElementById('sb-nm').textContent = user.prenom + ' ' + user.nom
  document.getElementById('logout-btn').onclick = () => logout(2)
  document.getElementById('logout-link').onclick = (e) => { e.preventDefault(); logout(2) }

  await loadWallet()
  hideLoader()
}

async function loadWallet() {
  currentWallet = await getWallet(currentUser.id)
  document.getElementById('w-balance').textContent = formatPrice(currentWallet?.balance || 0)
  document.getElementById('sb-st').innerHTML = `<div class="sidebar-stat"><div class="val">${formatPrice(currentWallet?.balance || 0)}</div><div class="lbl">Solde</div></div>`

  const { data: txs } = await supabase.from('transactions').select('*').eq('wallet_id', currentWallet.id).order('created_at', { ascending: false }).limit(100)
  renderTransactions(txs || [])
}

function renderTransactions(txs) {
  const tb = document.getElementById('tx-table'), em = document.getElementById('tx-empty')
  if (!txs.length) { tb.innerHTML = ''; em.style.display = 'block'; return }
  em.style.display = 'none'
  tb.innerHTML = txs.map(tx => `<tr>
    <td>${formatDateTime(tx.created_at)}</td>
    <td><span class="badge ${tx.type === 'credit' ? 'badge-success' : 'badge-danger'}">${tx.type === 'credit' ? 'Crédit' : 'Débit'}</span></td>
    <td>${tx.description || '—'}</td>
    <td style="font-weight:700;color:${tx.type === 'credit' ? 'var(--green)' : 'var(--red)'}">${tx.type === 'credit' ? '+' : '-'}${formatPrice(tx.amount)}</td>
  </tr>`).join('')
}

window.openRecharge = function() { document.getElementById('recharge-modal').classList.add('open') }
window.setAmount = function(amount) { document.getElementById('recharge-amount').value = amount }

window.doRecharge = async function() {
  const amount = parseFloat(document.getElementById('recharge-amount').value)
  if (!amount || amount < 5) { showToast('Le montant minimum est de 5 €.', 'warning'); return }

  await creditWallet(currentUser.id, amount, 'Recharge portefeuille (simulée — en attente de Stripe)')
  document.getElementById('recharge-modal').classList.remove('open')
  showToast(`Portefeuille rechargé de ${formatPrice(amount)} !`, 'success')
  await loadWallet()
}

init()
