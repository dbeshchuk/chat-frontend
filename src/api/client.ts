export const api = {
  ingest: (mutations: any[]) => {
    return fetch(`/api/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mutations }),
    });
  },
};
