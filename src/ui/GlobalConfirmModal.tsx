import { useConfirmModalStore } from '../store/confirmModalStore';
import ConfirmModal from './ConfirmModal';

/**
 * App-level singleton renderer for the global confirm modal. Mount once
 * in App.tsx; any code path can then call
 * `useConfirmModalStore.getState().request(...)` and await the user's decision.
 */
export default function GlobalConfirmModal() {
  const { isOpen, title, message, confirmLabel, cancelLabel, danger, confirm, cancel } =
    useConfirmModalStore();

  return (
    <ConfirmModal
      open={isOpen}
      title={title}
      message={message}
      confirmLabel={confirmLabel}
      cancelLabel={cancelLabel}
      danger={danger}
      onConfirm={confirm}
      onCancel={cancelLabel ? cancel : undefined}
    />
  );
}
