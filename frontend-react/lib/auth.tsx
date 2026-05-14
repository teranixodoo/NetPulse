"use client";

import React, { createContext, useContext, useState, useEffect, useCallback } from "react";
import Cookies from "js-cookie";
import { authApi } from "./api";
import type { User } from "./types";

interface AuthState {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Načteme uloženého uživatele z cookie při startu
  useEffect(() => {
    const token = Cookies.get("np_token");
    const userJson = Cookies.get("np_user");
    if (token && userJson) {
      try {
        setUser(JSON.parse(userJson));
      } catch {
        Cookies.remove("np_user");
      }
    }
    setIsLoading(false);
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const token = await authApi.login({ username, password });
    // Načteme skutečnou roli uživatele z JWT tokenu (payload je base64)
    let role: "admin" | "viewer" = "viewer";
    try {
      const payload = JSON.parse(atob((token.access_token || Cookies.get('np_token') || '').split('.')[1]));
      role = payload.role === 'admin' ? 'admin' : 'viewer';
    } catch { role = 'viewer'; }
    const userData: User = { id: 0, username, role };
    Cookies.set("np_user", JSON.stringify(userData), { expires: 1, sameSite: "lax" });
    setUser(userData);
  }, []);

  const logout = useCallback(() => {
    authApi.logout();
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoading,
        isAuthenticated: !!user,
        login,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth musí být uvnitř AuthProvider");
  return ctx;
}
