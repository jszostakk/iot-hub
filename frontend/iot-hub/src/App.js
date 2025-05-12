// src/App.js
import React, { useState, useEffect } from 'react';
import { Amplify } from 'aws-amplify';

import {
  signIn,
  signOut as signOutAuth,
  getCurrentUser,
  fetchAuthSession,
  resetPassword,
  confirmResetPassword,
  confirmSignIn,
} from '@aws-amplify/auth';
import { get as apiGet, post as apiPost } from '@aws-amplify/api-rest';
import awsconfig from './aws-exports';

Amplify.configure(awsconfig);

/* ───── optional helper for the AdminResetUserPassword Lambda ───── */
const API_BASE = process.env.REACT_APP_API_URL;      // put ApiURL from CDK in .env
const postJSON = (path, body) =>
  fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });

export default function App() {
  /* ---------- auth state ---------- */
  const [email, setEmail]                 = useState('');
  const [password, setPassword]           = useState('');
  const [isAuthenticated, setIsAuthenticated] = useState(null);

  /* extra states for password challenges / reset */
  const [tmpPwChallenge, setTmpPwChallenge]     = useState(false);
  const [inResetFlow,    setInResetFlow]        = useState(false);
  const [verificationCode, setVerificationCode] = useState('');
  const [newPassword, setNewPassword]           = useState('');

  /* ---------- check existing session on mount ---------- */
  useEffect(() => {
    (async () => {
      try {
        await getCurrentUser();
        setIsAuthenticated(true);
      } catch {
        setIsAuthenticated(false);
      }
    })();
  }, []);

  /* ---------- sign-in ---------- */
  const login = async () => {
    try {
      const result = await signIn({ username: email, password });
      const { signInStep } = result.nextStep;

      switch (signInStep) {
        case 'DONE':
          await fetchAuthSession();
          setIsAuthenticated(true);
          alert('✅ Login successful!');
          break;

        case 'RESET_PASSWORD':                   // admin set RESET_REQUIRED
          await startResetFlow(email);
          break;

        case 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED':
          setTmpPwChallenge(true);               // temp password still valid
          break;

        default:
          console.warn('[Auth] unhandled step:', signInStep);
      }
    } catch (err) {
      /* temp password exists but already EXPIRED */
      if (
        err.name === 'NotAuthorizedException' &&
        /Temporary password has expired/i.test(err.message)
      ) {
        await triggerAdminReset(email);          // optional helper below
        return;
      }
      console.error('login error', err);
      alert('🚫 Login failed: ' + err.message);
    }
  };

  /* ---------- optional AdminResetUserPassword fallback ---------- */
  const triggerAdminReset = async (username) => {
    try {
      await postJSON('/reset-expired-password', { username });
      alert('📧 A reset code has been emailed to you.');
      await startResetFlow(username);
    } catch (err) {
      console.error('[Reset] admin reset failed', err);
      alert('❌ Automatic reset failed. Contact support.');
    }
  };

  /* ---------- NEW_PASSWORD_REQUIRED challenge ---------- */
  const submitNewPassword = async () => {
    try {
      await confirmSignIn({ challengeResponse: newPassword });
      await fetchAuthSession();
      setTmpPwChallenge(false);
      setIsAuthenticated(true);
      alert('✅ Password set and login complete!');
    } catch (err) {
      console.error('[Auth] confirmSignIn error', err);
      alert('❌ Could not set new password: ' + err.message);
    }
  };

  /* ---------- self-service reset ---------- */
  const startResetFlow = async (username) => {
    if (!username) return alert('Enter your email first.');
    try {
      await resetPassword({ username });
      setInResetFlow(true);
      alert('📧 Verification code sent to your email.');
    } catch (err) {
      /* user still FORCE_CHANGE_PASSWORD but temp-pw not expired */
      if (
        err.name === 'NotAuthorizedException' &&
        /current state/i.test(err.message)
      ) {
        await triggerAdminReset(username);       // fallback
        return;
      }
      console.error('[Auth] resetPassword error', err);
      alert('❌ Reset failed: ' + err.message);
    }
  };

  const confirmReset = async () => {
    try {
      await confirmResetPassword({
        username: email,
        confirmationCode: verificationCode,
        newPassword,
      });
      alert('✅ Password reset. Sign in with the new password.');
      setInResetFlow(false);
      setPassword('');
    } catch (err) {
      console.error('[Auth] confirmResetPassword error', err);
      alert('❌ Confirmation failed: ' + err.message);
    }
  };

  /* ---------- sign-out ---------- */
  const logout = async () => {
    try {
      await signOutAuth();
      setIsAuthenticated(false);
    } catch (err) {
      console.error('logout error', err);
    }
  };

  /* ---------- IoT API helpers ---------- */
  const callONLed = async () => {
    try {
      const res = await postJSON('/set-led', {
        topic: 'button/press',
        message: 'ON'
      });
      console.log('LED ON →', res);
    } catch (err) {
      console.error('LED ON error →', err);
    }
  };
  
  const callOFFLed = async () => {
    try {
      const res = await postJSON('/set-led', {
        topic: 'button/press',
        message: 'OFF'
      });
      console.log('LED OFF →', res);
    } catch (err) {
      console.error('LED OFF error →', err);
    }
  };   

  /* ---------- UI ---------- */
  if (isAuthenticated === null) return <div>Loading...</div>;

  return (
    <div style={{ padding: 20 }}>
      <h1>IoT Hub Frontend</h1>

      {isAuthenticated ? (
        <>
          <p>👋 You’re signed in</p>
          <button onClick={logout}>Sign Out</button>
          <hr />
          <button onClick={callONLed}>Turn LED ON</button>{' '}
          <button onClick={callOFFLed}>Turn LED OFF</button>
        </>
      ) : tmpPwChallenge ? (
        <>
          <h2>Set a New Password</h2>
          <input
            type="password"
            placeholder="New Password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
          /><br /><br />
          <button onClick={submitNewPassword}>Submit</button>
        </>
      ) : inResetFlow ? (
        <>
          <h2>Reset Password</h2>
          <input
            type="text"
            placeholder="Verification Code"
            value={verificationCode}
            onChange={(e) => setVerificationCode(e.target.value)}
          /><br /><br />
          <input
            type="password"
            placeholder="New Password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
          /><br /><br />
          <button onClick={confirmReset}>Submit New Password</button>
        </>
      ) : (
        <>
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          /><br /><br />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          /><br /><br />
          <button onClick={login}>Login</button>{' '}
          <button onClick={() => startResetFlow(email)}>Forgot Password</button>
        </>
      )}
    </div>
  );
}
