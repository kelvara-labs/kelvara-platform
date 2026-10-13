export function bindProtectionAction(button, action, targetId, invoke) {
  if (!button || typeof invoke !== 'function') throw new TypeError('protection_action_binding_invalid');
  if (typeof targetId !== 'string' || !targetId) throw new Error('protection_target_required');
  button.dataset.targetId = targetId;
  button.onclick = () => invoke(action, targetId);
  return button;
}
