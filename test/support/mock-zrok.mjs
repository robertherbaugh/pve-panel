// zrok 2.0.9 OpenAPI contract simulator. Reject wrong verbs, account scopes and
// field names so tests cannot silently validate a fictional controller API.
import http from "node:http";
import { randomUUID } from "node:crypto";
export async function startMockZrok() {
  const accounts = new Map(),
    requests = [],
    adminToken = "zrok-admin-secret-for-api-tests-0123456789";
  const state = {
    accounts,
    requests,
    adminToken,
    failDelete: false,
    offline: false,
    loseShare: false,
    openNamespace: false,
  };
  const server = http.createServer(async (req, res) => {
    const send = (v, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(v === undefined ? "" : JSON.stringify(v));
    };
    let body = "";
    for await (const chunk of req) body += chunk;
    if (body && req.headers["content-type"] !== "application/zrok.v1+json")
      return send({ message: "no consumer registered for content type" }, 500);
    const b = body ? JSON.parse(body) : {};
    const path = new URL(req.url, "http://127.0.0.1").pathname.replace(
      "/api/v2",
      "",
    );
    const key = req.headers["x-token"],
      admin = key === adminToken;
    const a = [...accounts.values()].find((a) => a.token === key);
    requests.push({ method: req.method, path, body: b, key });
    const is = (method, p) => req.method === method && path === p;
    if (is("GET", "/versions")) return send({ controllerVersion: "v2.0.9" });
    if (is("POST", "/login")) {
      const a = accounts.get(b.email);
      return send(
        a?.password === b.password ? a.token : {},
        a?.password === b.password ? 200 : 401,
      );
    }
    if (is("GET", "/namespaces"))
      return send(
        [
          {
            namespaceToken: "public",
            name: "share.rcadea.cloud",
            ...(state.openNamespace ? { open: true } : {}),
          },
        ],
        admin ? 200 : 401,
      );
    if (is("POST", "/account")) {
      if (!admin) return send({}, 401);
      if (accounts.has(b.email)) return send({}, 500);
      const a = {
        ...b,
        token: `account-${randomUUID()}`,
        envs: new Map(),
        names: [],
        namespaceGranted: false,
      };
      accounts.set(a.email, a);
      return send({ accountToken: a.token }, 201);
    }
    if (is("DELETE", "/account")) {
      if (!admin) return send({}, 401);
      if (state.failDelete) return send({}, 503);
      const exists = accounts.delete(b.email);
      return send(undefined, exists ? 200 : 404);
    }
    if (path === "/namespace/grant") {
      if (!admin) return send({}, 401);
      const a = accounts.get(b.email);
      if (!a) return send({}, 404);
      a.namespaceGranted = req.method === "POST";
      return send();
    }
    if (!a) return send({}, 401);
    if (is("GET", "/environments"))
      return send({
        environments: [...a.envs.values()].map((e) => ({ zId: e.id })),
      });
    if (is("POST", "/enable")) {
      const id = randomUUID();
      a.envs.set(id, { id, enrolled: false, shares: new Map() });
      return send(
        {
          identity: id,
          cfg: JSON.stringify({
            ztAPI: "https://ziti.example",
            id: { key: "private-machine-key" },
          }),
        },
        201,
      );
    }
    if (is("POST", "/disable")) {
      a.envs.delete(b.identity);
      return send();
    }
    if (is("POST", "/agent/unenroll")) {
      const e = a.envs.get(b.envZId);
      if (!e?.enrolled) return send({}, 400);
      e.enrolled = false;
      return send();
    }
    if (is("POST", "/agent/enroll")) {
      const e = a.envs.get(b.envZId);
      if (!e || e.enrolled) return send({}, 400);
      e.enrolled = true;
      return send({ token: `enroll-${randomUUID()}` });
    }
    if (is("POST", "/agent/ping"))
      return send({ version: "v2.0.9" }, state.offline ? 502 : 200);
    if (is("POST", "/agent/status")) {
      if (state.offline) return send({}, 502);
      const e = a.envs.get(b.envZId);
      if (!e) return send({}, 401);
      return send({
        shares: [...e.shares.values()].map(({ grants, ...s }) => s),
      });
    }
    if (is("GET", "/share/names")) return send(a.names);
    if (is("POST", "/share/name")) {
      if (!a.namespaceGranted) return send({}, 401);
      a.names.push({ ...b, reserved: false });
      return send(undefined, 201);
    }
    if (is("PATCH", "/share/name")) {
      const n = a.names.find(
        (n) => n.name === b.name && n.namespaceToken === b.namespaceToken,
      );
      if (!n) return send({}, 404);
      n.reserved = b.reserved;
      return send();
    }
    if (is("POST", "/agent/share")) {
      if (state.offline) return send({}, 502);
      const e = a.envs.get(b.envZId);
      if (!e?.enrolled) return send({}, 401);
      if (b.shareMode === "public" && !a.namespaceGranted) return send({}, 401);
      if (b.shareMode === "private" && b.open !== false) return send({}, 422);
      // A supplied token means attach an existing reserved share, not create it.
      if (b.privateShareToken) return send({}, 502);
      const token = b.privateShareToken ?? randomUUID();
      const endpoints =
        b.shareMode === "public"
          ? [`${b.nameSelections[0].name}.share.rcadea.cloud`]
          : [];
      e.shares.set(token, {
        token,
        shareMode: b.shareMode,
        backendMode: b.backendMode,
        backendEndpoint: b.target,
        frontendEndpoints: endpoints,
        open: b.open,
        status: "active",
        zId: randomUUID(),
        grants: new Set(),
      });
      if (state.loseShare) {
        state.loseShare = false;
        res.destroy();
        return;
      }
      return send({ token, frontendEndpoints: endpoints });
    }
    if (is("POST", "/agent/unshare")) {
      if (state.offline) return send({}, 502);
      const e = a.envs.get(b.envZId);
      e?.shares.delete(b.token);
      return send();
    }
    if (is("DELETE", "/unshare")) {
      const e = a.envs.get(b.envZId);
      const found = e?.shares.delete(b.shareToken);
      return send(undefined, found ? 200 : 404);
    }
    if (req.method === "GET" && path.startsWith("/detail/share/")) {
      const token = path.split("/").at(-1);
      const s = [...a.envs.values()]
        .flatMap((e) => [...e.shares.values()])
        .find((s) => s.token === token);
      return send(s ? { shareToken: s.token, zId: s.zId } : {}, s ? 200 : 404);
    }
    if (is("PATCH", "/share")) {
      const s = [...a.envs.values()]
        .flatMap((e) => [...e.shares.values()])
        .find((s) => s.token === b.shareToken);
      if (!s) return send({}, 404);
      for (const email of b.addAccessGrants ?? []) {
        if (!accounts.has(email)) return send({}, 400);
        s.grants.add(email);
      }
      for (const email of b.removeAccessGrants ?? []) s.grants.delete(email);
      return send();
    }
    send({ error: `Unsupported zrok contract: ${req.method} ${path}` }, 404);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    ...state,
    get failDelete() {
      return state.failDelete;
    },
    set failDelete(v) {
      state.failDelete = v;
    },
    get offline() {
      return state.offline;
    },
    set offline(v) {
      state.offline = v;
    },
    get loseShare() {
      return state.loseShare;
    },
    set loseShare(v) {
      state.loseShare = v;
    },
    get openNamespace() {
      return state.openNamespace;
    },
    set openNamespace(v) {
      state.openNamespace = v;
    },
    url: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(r);
      }),
  };
}
