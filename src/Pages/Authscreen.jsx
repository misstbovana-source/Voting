import React, { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
} from 'firebase/auth';
import { auth } from '../firebase-config';
import LOGO_URL from '../assets/Voting.logo.jpeg';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

const ROUTES = {
  home: '/dashboard',
};

// const LOGO_URL = new URL('../assets/Voting.logo.jpeg', import.meta.url).href;

const PASSWORD_RULES = [
  { id: 'len', label: '8+ characters', test: (p) => p.length >= 8 },
  { id: 'upper', label: 'An uppercase letter', test: (p) => /[A-Z]/.test(p) },
  { id: 'num', label: 'A number', test: (p) => /\d/.test(p) },
  { id: 'special', label: 'A special character', test: (p) => /[\W_]/.test(p) },
];

const validatePassword = (p) => PASSWORD_RULES.every((rule) => rule.test(p));

const appError = (message) => Object.assign(new Error(message), { appError: true });

const apiRequest = async (path, { method = 'GET', token, body } = {}) => {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  const detail = data?.message || data?.detail;
  return {
    ok: response.ok && data?.success !== false,
    status: response.status,
    data,
    message: typeof detail === 'string' ? detail : '',
  };
};

const friendlySignInError = (err) => {
  if (err?.appError) return err.message;
  switch (err?.code) {
    case 'auth/user-not-found':
    case 'auth/wrong-password':
    case 'auth/invalid-credential':
      return 'Incorrect email or password.';
    case 'auth/invalid-email':
      return 'The email address is invalid.';
    case 'auth/user-disabled':
      return 'Your account has been disabled. Please contact support.';
    case 'auth/too-many-requests':
      return 'Too many login attempts. Please try again later.';
    case 'auth/network-request-failed':
      return 'Network error. Please check your connection and try again.';
    default:
      return err?.message || 'An unexpected error occurred. Please try again.';
  }
};

const friendlySignUpError = (err) => {
  if (err?.appError) return err.message;
  switch (err?.code) {
    case 'auth/email-already-in-use':
      return 'The email address is already in use by another account.';
    case 'auth/invalid-email':
      return 'The email address is invalid.';
    case 'auth/operation-not-allowed':
      return 'Email/password accounts are not enabled. Please contact support.';
    case 'auth/weak-password':
      return 'The password is too weak. Please choose a stronger password.';
    case 'auth/network-request-failed':
      return 'Network error. Please check your connection and try again.';
    default:
      return err?.message || 'An unexpected error occurred. Please try again.';
  }
};

const FOCUS =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pink-400 focus-visible:ring-offset-2 focus-visible:ring-offset-white';

const INPUT =
  'w-full rounded-lg border border-[#eee8ee] bg-white px-4 py-3 text-sm text-[#2a1522] placeholder:text-[#b3a6b3] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pink-400';

function Spinner({ className = 'h-5 w-5' }) {
  return (
    <span
      className={`inline-block animate-spin rounded-full border-2 border-white/30 border-t-white ${className}`}
      role="status"
      aria-label="Loading"
    />
  );
}

function Field({ id, label, children }) {
  return (
    <div className="mb-4">
      <label htmlFor={id} className="mb-1.5 block text-xs font-semibold text-[#6b5a6b]">
        {label}
      </label>
      {children}
    </div>
  );
}

function Banner({ type, children }) {
  const tone =
    type === 'error'
      ? 'border-red-200 bg-red-50 text-red-700'
      : 'border-emerald-200 bg-emerald-50 text-emerald-800';
  return (
    <div role={type === 'error' ? 'alert' : 'status'} className={`mb-5 rounded-lg border px-4 py-3 text-xs ${tone}`}>
      {children}
    </div>
  );
}

function Logo() {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-pink-100 font-[Manrope] text-2xl font-extrabold text-[#4a1834]">
        V
      </div>
    );
  }
  return (
    <img
  src={LOGO_URL}
  alt="VApp Logo"
        className="mx-auto mb-4 h-16 w-16 rounded-full object-cover ring-2 ring-pink-300/70"

/>

  );
}

export default function AuthScreen({ onAuthenticated }) {
  const navigate = useNavigate();
  const location = useLocation();

  const [mode, setMode] = useState('signin');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const isSignUp = mode === 'signup';

  const switchMode = (next) => {
    if (next === mode) return;
    setMode(next);
    setError('');
    setNotice('');
    setPassword('');
    setConfirmPassword('');
    setShowPassword(false);
  };

  const handleSignIn = async () => {
    if (!email || !password) {
      setError('Please fill in both email and password.');
      return;
    }

    setLoading(true);
    try {
      const credential = await signInWithEmailAndPassword(auth, email.trim(), password);
      const token = await credential.user.getIdToken();

      const res = await apiRequest('/api/users/me', { token });
      if (!res.ok) {
        throw appError(
          res.status === 404
            ? 'User profile not found. Please contact support.'
            : res.message || 'Could not load your profile. Please try again.'
        );
      }

      const profile = res.data?.user;
      onAuthenticated?.(profile);
      navigate(location.state?.from?.pathname || ROUTES.home, { replace: true });
    } catch (err) {
      console.error('Login error:', err?.code, err?.message);
      setError(friendlySignInError(err));
    } finally {
      setLoading(false);
    }
  };

  const handleSignUp = async () => {
    if (!email || !fullName.trim()) {
      setError('Please fill in all required fields.');
      return;
    }
    if (!validatePassword(password)) {
      setError('Password must be at least 8 characters, include an uppercase letter, a number, and a special character.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Password and confirm password do not match.');
      return;
    }

    setLoading(true);
    try {
      const credential = await createUserWithEmailAndPassword(auth, email.trim(), password);
      const token = await credential.user.getIdToken();

      const res = await apiRequest('/api/users/profile', {
        method: 'POST',
        token,
        body: { fullName: fullName.trim() },
      });
      if (!res.ok) {
        throw appError(
          res.message
            ? `Your account was created but your profile could not be saved: ${res.message}`
            : 'Your account was created but your profile could not be saved. Please try again.'
        );
      }

      setMode('signin');
      setPassword('');
      setConfirmPassword('');
      setFullName('');
      setNotice('Account created successfully! Please sign in.');
    } catch (err) {
      console.error('Sign up error:', err?.code, err?.message);
      setError(friendlySignUpError(err));
    } finally {
      setLoading(false);
    }
  };

  const handleForgotPassword = async () => {
    setError('');
    setNotice('');
    if (!email) {
      setError('Please enter your email address to reset your password.');
      return;
    }
    try {
      await sendPasswordResetEmail(auth, email.trim());
      setNotice(
        'If an account exists for that email, a password reset link has been sent to your inbox. Please check your email (and spam folder).'
      );
    } catch (err) {
      console.error('Password reset error:', err);
      if (err?.code === 'auth/user-not-found') {
        setNotice('If an account exists for that email, a password reset link has been sent to your inbox.');
      } else if (err?.code === 'auth/invalid-email') {
        setError('The email address is invalid.');
      } else {
        setError(err?.message || 'Could not send password reset email.');
      }
    }
  };

  const onSubmit = (e) => {
    e.preventDefault();
    if (loading) return;
    setError('');
    setNotice('');
    return isSignUp ? handleSignUp() : handleSignIn();
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#fbf8fb] px-5 py-10 text-[#2a1522]">
      <div className="w-full max-w-md overflow-hidden rounded-2xl border border-[#eee8ee] bg-white shadow-sm">
        <div className="bg-gradient-to-br from-[#351128] via-[#54183c] to-[#8e285f] px-8 pb-8 pt-9 text-center text-white">
          <Logo />
          <p className="flex items-center justify-center gap-2 text-[9px] font-bold tracking-[1.7px] text-pink-100/80">
            <span className="size-1.5 rounded-full bg-emerald-400" /> YOUR VOTING COMMAND CENTRE
          </p>
          <h1 className="mt-3 font-[Manrope] text-3xl font-extrabold leading-tight">
            {isSignUp ? 'Create your account' : 'Welcome back'}
          </h1>
          <p className="mt-2 text-xs text-pink-100/80">
            {isSignUp ? 'Create your account to get started.' : 'Sign in to continue.'}
          </p>
        </div>

        <div className="p-8">
          <div role="tablist" aria-label="Sign in or sign up" className="mb-6 grid grid-cols-2 rounded-lg bg-[#f7f1f7] p-1">
            {[
              { id: 'signin', label: 'Sign In' },
              { id: 'signup', label: 'Sign Up' },
            ].map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={mode === tab.id}
                onClick={() => switchMode(tab.id)}
                className={`rounded-md py-2.5 text-xs font-bold transition-colors motion-reduce:transition-none ${FOCUS} ${
                  mode === tab.id ? 'bg-[#45152f] text-white' : 'text-[#6b5a6b] hover:text-[#45152f]'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {error && <Banner type="error">{error}</Banner>}
          {notice && <Banner type="success">{notice}</Banner>}

          <form onSubmit={onSubmit} noValidate>
            {isSignUp && (
              <Field id="fullName" label="Full name">
                <input
                  id="fullName"
                  className={INPUT}
                  placeholder="Full name"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  autoComplete="name"
                />
              </Field>
            )}

            <Field id="email" label="Email">
              <input
                id="email"
                type="email"
                className={INPUT}
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                autoCapitalize="none"
              />
            </Field>

            <Field id="password" label="Password">
              <div className="relative">
                <input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  className={`${INPUT} pr-16`}
                  placeholder="Password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete={isSignUp ? 'new-password' : 'current-password'}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className={`absolute right-3 top-1/2 -translate-y-1/2 rounded-md px-2 py-1 text-[11px] font-bold text-[#948795] hover:text-[#45152f] ${FOCUS}`}
                  aria-pressed={showPassword}
                >
                  {showPassword ? 'Hide' : 'Show'}
                </button>
              </div>

              {isSignUp && (
                <ul className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1">
                  {PASSWORD_RULES.map((rule) => {
                    const ok = rule.test(password);
                    return (
                      <li key={rule.id} className={`text-[11px] ${ok ? 'text-emerald-600' : 'text-[#b3a6b3]'}`}>
                        {ok ? '✓' : '•'} {rule.label}
                      </li>
                    );
                  })}
                </ul>
              )}
            </Field>

            {isSignUp && (
              <Field id="confirmPassword" label="Confirm password">
                <input
                  id="confirmPassword"
                  type={showPassword ? 'text' : 'password'}
                  className={INPUT}
                  placeholder="Confirm password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  autoComplete="new-password"
                />
              </Field>
            )}

            {!isSignUp && (
              <div className="-mt-2 mb-5 text-right">
                <button
                  type="button"
                  onClick={handleForgotPassword}
                  className={`rounded-md text-xs font-semibold text-pink-600 hover:text-pink-700 ${FOCUS}`}
                >
                  Forgot password?
                </button>
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className={`flex w-full items-center justify-center rounded-lg bg-[#45152f] py-3.5 text-sm font-bold text-white transition hover:bg-[#64214a] disabled:cursor-not-allowed disabled:opacity-70 ${FOCUS}`}
            >
              {loading ? <Spinner /> : isSignUp ? 'Create account' : 'Log in'}
            </button>
          </form>

          <p className="mt-6 text-center text-xs text-[#948795]">
            {isSignUp ? 'Already have an account? ' : 'Don’t have an account? '}
            <button
              type="button"
              onClick={() => switchMode(isSignUp ? 'signin' : 'signup')}
              className={`rounded-md font-bold text-pink-600 hover:text-pink-700 ${FOCUS}`}
            >
              {isSignUp ? 'Sign in' : 'Sign up'}
            </button>
          </p>
        </div>
      </div>
    </main>
  );
}