import { Modal } from '../../design';
import { closeSignIn, useAuth } from '../../state/auth';
import { SignInPanel } from './ProfilePage';

/** The sign-in / sign-up dialog, opened from the avatar menu or by an action that needs an account (save, post, vote).
 *  Closes by itself once a session exists. */
export function SignInDialog() {
  const open = useAuth((s) => s.signInOpen && s.status !== 'signed-in' && s.status !== 'unconfigured');
  const reason = useAuth((s) => s.signInReason);
  return (
    <Modal open={open} onClose={closeSignIn} title="Account" eyebrow="TERRATRACE" width={440}>
      <div className="p-5" data-testid="sign-in-dialog"><SignInPanel titleId="sign-in-title" reason={reason} /></div>
    </Modal>
  );
}
