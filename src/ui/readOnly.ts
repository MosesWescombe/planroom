import { isReadOnly } from '../shared/derive';
import { useSelector } from './store';

/**
 * True once the proposal is accepted or the user ended the session, and on a plan the standalone browser shows: it is
 * then read-only everywhere.
 */
export function useReadOnly(): boolean {
    return useSelector((view) => isReadOnly(view) || Boolean(view.viewOnly));
}
