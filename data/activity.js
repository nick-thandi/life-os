// Activity data layer: what the brain did. Talks to the brain's activity endpoint with the
// app's own Google sign-in; the server checks the account before returning anything.
(function () {
  const cfg = window.LIFE_OS_CONFIG;
  async function call(method, body) {
    const token = window.LifeOSData.accessToken();
    if (!token) throw new Error("not signed in");
    const res = await fetch(cfg.brainUrl + "/activity", {
      method, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: body && method !== "GET" ? JSON.stringify(body) : undefined,
    });
    const j = await res.json().catch(() => ({}));
    if (res.status === 401) {
      window.LifeOSData.dropToken();
      if (!body?._retried && await window.LifeOSData.signInSilently()) return call(method, Object.assign({}, body || {}, { _retried: true }));
      throw new Error("not signed in");
    }
    if (!res.ok) throw new Error(j.error || ("Brain said " + res.status));
    return j;
  }
  window.LifeOSActivity = {
    list: () => call("GET"),
    undo: (id) => call("POST", { undo: id }),
    approve: (id) => call("POST", { approve: id }),
  };
})();
