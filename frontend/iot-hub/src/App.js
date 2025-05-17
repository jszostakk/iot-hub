// src/App.js
import React, { useEffect, useState } from 'react';
import { Amplify } from 'aws-amplify';
import {
  signIn,
  confirmSignIn,
  signOut as signOutAuth,
  getCurrentUser,
  fetchAuthSession,
  resetPassword,
  confirmResetPassword,
} from 'aws-amplify/auth';
import awsconfig from './aws-exports';
import { QRCodeSVG } from 'qrcode.react';

Amplify.configure(awsconfig);

// ───────── helper for your Go Lambda ─────────
const API_BASE = process.env.REACT_APP_API_URL;
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
  /* ---------- basic auth state ---------- */
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isAuthenticated, setIsAuthenticated] = useState(null);

  /* NEW-PASSWORD challenge */
  const [tmpPwChallenge, setTmpPwChallenge] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  /* RESET-PASSWORD flow */
  const [inResetFlow, setInResetFlow] = useState(false);
  const [verificationCode, setVerificationCode] = useState('');

  /* MFA:  null | 'totpSetup' | 'signinTotp' */
  const [mfaStage, setMfaStage] = useState(null);
  const [qrUri, setQrUri] = useState('');
  const [mfaCode, setMfaCode] = useState('');

  /* ---------- check session on mount ---------- */
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
      const { nextStep } = await signIn({ username: email, password });

      handleNextStep(nextStep);
    } catch (err) {
      console.error(err);
      alert(`Login failed: ${err.message}`);
    }
  };

  /* ---------- central next-step handler ---------- */
  const handleNextStep = (nextStep) => {
    switch (nextStep.signInStep) {
      case 'DONE':
        setIsAuthenticated(true);
        break;

      case 'RESET_PASSWORD':
        startResetFlow(email);
        break;

      case 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED':
        setTmpPwChallenge(true);
        break;

      case 'CONFIRM_SIGN_IN_WITH_TOTP_CODE':
        /* user already has MFA configured */
        setMfaStage('signinTotp');
        break;

      case 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP':
        /* first-time TOTP setup */
        const uri = nextStep.totpSetupDetails.getSetupUri({
          issuer: 'IoTHub',
          label: email,
        });
        setQrUri(uri);
        setMfaStage('totpSetup');
        break;

      default:
        console.warn('Unhandled nextStep:', nextStep.signInStep);
    }
  };

  /* ---------- confirm new-password ---------- */
  const submitNewPassword = async () => {
    if (newPassword !== confirmPassword)
      return alert('Passwords do not match');

    try {
      const { nextStep } = await confirmSignIn({
        challengeResponse: newPassword,
      });
      setTmpPwChallenge(false);
      handleNextStep(nextStep);
    } catch (err) {
      alert(`Could not set new password: ${err.message}`);
    }
  };

  /* ---------- confirm TOTP (either setup or sign-in) ---------- */
  const submitTotpCode = async () => {
    try {
      const { nextStep } = await confirmSignIn({
        challengeResponse: mfaCode,
      });
      setMfaCode('');
      handleNextStep(nextStep); // will be DONE when correct
    } catch (err) {
      alert(`Invalid code: ${err.message}`);
    }
  };

  /* ---------- password-reset helpers ---------- */
  const startResetFlow = async (username) => {
    if (!username) return alert('Enter email first');
    try {
      await resetPassword({ username });
      setInResetFlow(true);
    } catch (err) {
      alert(`Reset failed: ${err.message}`);
    }
  };

  const confirmReset = async () => {
    if (newPassword !== confirmPassword)
      return alert('Passwords do not match');

    try {
      await confirmResetPassword({
        username: email,
        confirmationCode: verificationCode,
        newPassword,
      });
      alert('Password reset – sign in with the new password.');
      setInResetFlow(false);
      setPassword('');
    } catch (err) {
      alert(`Confirmation failed: ${err.message}`);
    }
  };

  /* ---------- IoT helpers ---------- */
  const callONLed = () =>
    postJSON('/set-led', { topic: 'button/press', message: 'ON' });
  const callOFFLed = () =>
    postJSON('/set-led', { topic: 'button/press', message: 'OFF' });

  /* ---------- sign-out ---------- */
  const logout = async () => {
    await signOutAuth();
    setIsAuthenticated(false);
  };

  /* ---------- UI ---------- */
  if (isAuthenticated === null) return <div>Loading…</div>;

  return (
    <div style={{ padding: 20 }}>
      <h1>IoT Hub Frontend</h1>

      {isAuthenticated ? (
        /* ───── signed-in screen ───── */
        <>
          <p>👋 Signed in</p>
          <button onClick={logout}>Sign Out</button>
          <hr />
          <button onClick={callONLed}>LED ON</button>{' '}
          <button onClick={callOFFLed}>LED OFF</button>
        </>
      ) : tmpPwChallenge ? (
        /* ───── new-password screen ───── */
        <>
          <h2>Set New Password</h2>
          <input
            type="password"
            placeholder="New password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
          />
          <br />
          <br />
          <input
            type="password"
            placeholder="Confirm password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
          />
          <br />
          <br />
          <button onClick={submitNewPassword}>Submit</button>
        </>
      ) : inResetFlow ? (
        /* ───── reset-password screen ───── */
        <>
          <h2>Reset Password</h2>
          <input
            placeholder="Verification code"
            value={verificationCode}
            onChange={(e) => setVerificationCode(e.target.value)}
          />
          <br />
          <br />
          <input
            type="password"
            placeholder="New password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
          />
          <br />
          <br />
          <input
            type="password"
            placeholder="Confirm password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
          />
          <br />
          <br />
          <button onClick={confirmReset}>Confirm</button>
        </>
      ) : mfaStage === 'totpSetup' ? (
        /* ───── first-time TOTP setup ───── */
        <>
          <h2>Enable TOTP MFA</h2>
          <QRCodeSVG value={qrUri} />
          <br />
          <br />
          <input
            placeholder="6-digit code"
            value={mfaCode}
            onChange={(e) => setMfaCode(e.target.value)}
          />
          <br />
          <br />
          <button onClick={submitTotpCode}>Verify</button>
        </>
      ) : mfaStage === 'signinTotp' ? (
        /* ───── regular TOTP challenge ───── */
        <>
          <h2>Enter TOTP Code</h2>
          <input
            placeholder="6-digit code"
            value={mfaCode}
            onChange={(e) => setMfaCode(e.target.value)}
          />
          <br />
          <br />
          <button onClick={submitTotpCode}>Verify</button>
        </>
      ) : (
        /* ───── sign-in form ───── */
        <>
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <br />
          <br />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <br />
          <br />
          <button onClick={login}>Login</button>{' '}
          <button onClick={() => startResetFlow(email)}>Forgot Password</button>
        </>
      )}
    </div>
  );
}
