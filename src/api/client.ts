import { ml_dsa87 } from "@noble/post-quantum/ml-dsa.js";

const encodeBase64 = (bytes: Uint8Array, padded = false): string => {
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  const result = btoa(binary);
  return padded ? result : result.replace(/=+$/, "");
};

const encodeField = (key: string, value: unknown): string => {
  if (key.endsWith("_cert") || key.endsWith("_pkey") || key.endsWith("_b64")) {
    return encodeBase64(value as Uint8Array, true);
  }
  if (key.endsWith("_hash")) {
    return value as string;
  }
  if (value === true) return "true";
  if (value === false) return "false";
  if (value === null) return "null";
  if (typeof value === "number") return value.toString();
  if (typeof value === "string") return value;
  return String(value);
};

const buildSignatureData = (fields: Record<string, unknown>): string => {
  return Object.keys(fields)
    .sort()
    .map((key) => encodeField(key, fields[key]))
    .join("");
};

export const api = {
  ingest: (mutations: any[]) => {
    return fetch(`/api/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mutations }),
    });
  },

  ingestWithAuth: async (mutations: any[], signSkey: Uint8Array): Promise<Response> => {
    const challengeResp = await api.getChallenge();
    const challengeSig = ml_dsa87.sign(new TextEncoder().encode(challengeResp.challenge), signSkey);
    const signature = encodeBase64(challengeSig);

    return fetch(`/api/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        auth: {
          challenge_id: challengeResp.challenge_id,
          signature,
        },
        mutations,
      }),
    });
  },

  getChallenge: async (): Promise<{ challenge: string; challenge_id: string }> => {
    const resp = await fetch(`/api/challenge`, {
      headers: { accept: "application/json" },
    });
    return resp.json();
  },

  createUserCard: (
    name: string,
    userData: {
      user_hash: string;
      sign_pkey: Uint8Array;
      contact_pkey: Uint8Array;
      contact_cert: Uint8Array;
      crypt_pkey: Uint8Array;
      crypt_cert: Uint8Array;
      sign_skey: Uint8Array;
    },
  ) => {
    const ownerTimestamp = Math.floor(Date.now() / 1000);
    const deletedFlag = false;

    const signatureFields: Record<string, unknown> = {
      contact_cert: userData.contact_cert,
      contact_pkey: userData.contact_pkey,
      crypt_cert: userData.crypt_cert,
      crypt_pkey: userData.crypt_pkey,
      deleted_flag: deletedFlag,
      name,
      owner_timestamp: ownerTimestamp,
      sign_pkey: userData.sign_pkey,
      user_hash: userData.user_hash,
    };

    const signatureData = buildSignatureData(signatureFields);
    const signB64 = ml_dsa87.sign(new TextEncoder().encode(signatureData), userData.sign_skey);

    return {
      mutation: {
        type: "insert",
        modified: {
          user_hash: userData.user_hash,
          sign_pkey: encodeBase64(userData.sign_pkey, true),
          contact_pkey: encodeBase64(userData.contact_pkey, true),
          contact_cert: encodeBase64(userData.contact_cert, true),
          crypt_pkey: encodeBase64(userData.crypt_pkey, true),
          crypt_cert: encodeBase64(userData.crypt_cert, true),
          name,
          deleted_flag: deletedFlag,
          owner_timestamp: ownerTimestamp,
          sign_b64: encodeBase64(signB64, true),
        },
        syncMetadata: {
          relation: "user_cards",
        },
      },
      sign_skey: userData.sign_skey,
    };
  },
};
