export const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "/api/v1";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("monster_token");
}

export function setToken(token: string) {
  if (typeof window !== "undefined") {
    localStorage.setItem("monster_token", token);
  }
}

export function removeToken() {
  if (typeof window !== "undefined") {
    localStorage.removeItem("monster_token");
    localStorage.removeItem("monster_user");
  }
}

export function getUser() {
  if (typeof window === "undefined") return null;
  const user = localStorage.getItem("monster_user");
  return user ? JSON.parse(user) : null;
}

export async function fetchWithAuth(url: string, options: RequestInit = {}) {
  const token = getToken();
  const headers = new Headers(options.headers || {});
  
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  if (!headers.has("Content-Type") && !(options.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(`${API_BASE}${url}`, {
    ...options,
    headers,
  });

  if (response.status === 401 && typeof window !== "undefined") {
    removeToken();
    window.location.href = "/login";
  }

  return response;
}
