// src/App.jsx
import { useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { onAuthStateChanged } from "firebase/auth";
import { auth } from "./firebase-config";
import Layout from "../src/Pages/layout";
import Dashboard from "../src/Pages/dashboard";
import Profile from "../src/Pages/profile";
import Competitions from "./Pages/competition";
import ArtistsHub from "./Pages/Artist";
import AuthScreen from "./Pages/Authscreen";
import VotingPage from "./Pages/voting";

// Sends people who aren't signed in to /login, and brings them back afterwards.
function RequireAuth({ children }) {
  const location = useLocation();
  const [user, setUser] = useState(undefined); // undefined = Firebase is still checking

  useEffect(() => onAuthStateChanged(auth, setUser), []);

  if (user === undefined) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0A1A33]">
        <div
          className="h-10 w-10 animate-spin rounded-full border-2 border-amber-400/30 border-t-amber-400"
          role="status"
          aria-label="Loading"
        />
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  return children;
}

function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Public: sign in / sign up (no sidebar) */}
        <Route path="/login" element={<AuthScreen />} />

        {/* Everything else needs a signed-in user */}
        <Route
          path="/"
          element={
            <RequireAuth>
              <Layout />
            </RequireAuth>
          }
        >
          {/* Open the dashboard when the app starts */}
          <Route index element={<Navigate to="/dashboard" replace />} />

          {/* Your existing dashboard page */}
          <Route path="dashboard" element={<Dashboard />} />
          <Route path="profile" element={<Profile />} />
          <Route path="competition" element={<Competitions />} />
          <Route path="artists" element={<ArtistsHub />} />
          <Route path="competitions/:competitionId/artists/:artistId/vote" element={<VotingPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

export default App;