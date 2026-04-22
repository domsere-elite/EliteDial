'use client';

import { useReducer, useCallback } from 'react';

export type CallPhase = 'idle' | 'ringing' | 'connected' | 'wrap-up';

export interface AccountPreview {
  accountId: string;
  accountName: string;
  debtorName: string;
  balance: number;
  status: string;
}

export interface CallState {
  phase: CallPhase;
  callId: string | null;
  callerNumber: string;
  callerName: string;
  accountPreview: AccountPreview | null;
  startTime: number | null;
  direction: 'inbound' | 'outbound' | null;
}

type CallAction =
  | { type: 'CALL_INCOMING'; callerNumber: string; callerName: string; callId?: string; accountPreview?: AccountPreview | null; direction?: 'inbound' | 'outbound' }
  | { type: 'CALL_ANSWERED'; callId?: string }
  | { type: 'CALL_DECLINED' }
  | { type: 'CALL_ENDED' }
  | { type: 'DISPOSITION_SUBMITTED' }
  | { type: 'CALL_ERROR' }
  | { type: 'SET_ACCOUNT_PREVIEW'; accountPreview: AccountPreview | null }
  | { type: 'SET_CALL_ID'; callId: string };

const initialState: CallState = {
  phase: 'idle',
  callId: null,
  callerNumber: '',
  callerName: '',
  accountPreview: null,
  startTime: null,
  direction: null,
};

function callReducer(state: CallState, action: CallAction): CallState {
  switch (action.type) {
    case 'CALL_INCOMING':
      if (state.phase !== 'idle') return state;
      return {
        ...state,
        phase: 'ringing',
        callerNumber: action.callerNumber,
        callerName: action.callerName,
        callId: action.callId || null,
        accountPreview: action.accountPreview || null,
        direction: action.direction || 'inbound',
      };

    case 'CALL_ANSWERED':
      if (state.phase !== 'ringing') return state;
      return {
        ...state,
        phase: 'connected',
        callId: action.callId || state.callId,
        startTime: Date.now(),
      };

    case 'CALL_DECLINED':
      if (state.phase !== 'ringing') return state;
      return { ...initialState };

    case 'CALL_ENDED':
      if (state.phase !== 'connected') return state;
      return {
        ...state,
        phase: 'wrap-up',
        startTime: null,
      };

    case 'DISPOSITION_SUBMITTED':
      if (state.phase !== 'wrap-up') return state;
      return { ...initialState };

    case 'CALL_ERROR':
      if (state.phase === 'idle') return state;
      return { ...initialState };

    case 'SET_ACCOUNT_PREVIEW':
      return { ...state, accountPreview: action.accountPreview };

    case 'SET_CALL_ID':
      return { ...state, callId: action.callId };

    default:
      return state;
  }
}

export function useCallState() {
  const [state, dispatch] = useReducer(callReducer, initialState);

  const incomingCall = useCallback(
    (callerNumber: string, callerName: string, opts?: { callId?: string; accountPreview?: AccountPreview | null; direction?: 'inbound' | 'outbound' }) =>
      dispatch({ type: 'CALL_INCOMING', callerNumber, callerName, ...opts }),
    [],
  );

  const answerCall = useCallback(
    (callId?: string) => dispatch({ type: 'CALL_ANSWERED', callId }),
    [],
  );

  const declineCall = useCallback(() => dispatch({ type: 'CALL_DECLINED' }), []);
  const endCall = useCallback(() => dispatch({ type: 'CALL_ENDED' }), []);
  const submitDisposition = useCallback(() => dispatch({ type: 'DISPOSITION_SUBMITTED' }), []);
  const callError = useCallback(() => dispatch({ type: 'CALL_ERROR' }), []);
  const setAccountPreview = useCallback(
    (preview: AccountPreview | null) => dispatch({ type: 'SET_ACCOUNT_PREVIEW', accountPreview: preview }),
    [],
  );
  const setCallId = useCallback(
    (callId: string) => dispatch({ type: 'SET_CALL_ID', callId }),
    [],
  );

  return {
    ...state,
    incomingCall,
    answerCall,
    declineCall,
    endCall,
    submitDisposition,
    callError,
    setAccountPreview,
    setCallId,
  };
}
