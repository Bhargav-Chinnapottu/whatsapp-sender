# Deploying to Oracle Cloud (Always Free)

This guide runs the WhatsApp Contact Sender in Docker on an **Oracle Cloud
Always Free** VM. Oracle's free tier gives you an ARM (Ampere A1) VM with enough
RAM (up to 24 GB) and a persistent disk — the two things this app needs that
most "free tiers" don't provide (Chromium is memory-hungry, and the WhatsApp
session must survive restarts).

> ⚠️ **Note on verification:** The app code and the HTTP Basic Auth gate were
> tested locally and pass. The Docker image was **not** built/run in the
> development environment (Docker wasn't available there), so do the first
> `docker compose build` on the VM and watch for errors. The Dockerfile uses the
> standard system-Chromium pattern for Puppeteer, which is widely known to work.

---

## 1. Create the free VM

1. Sign up at https://www.oracle.com/cloud/free/ (credit card for identity check;
   Always Free resources are not charged).
2. **Compute → Instances → Create Instance**:
   - Image: **Ubuntu 22.04** (or Oracle Linux; commands below assume Ubuntu).
   - Shape: **VM.Standard.A1.Flex** (Ampere ARM). Give it **2 OCPU / 6–12 GB RAM**
     — all within Always Free limits. (The ARM shape matters; `node:20-bookworm-slim`
     and distro chromium both support arm64.)
   - Add your SSH public key.
3. **Networking:** after creation, open port 3000 (or better, 443 if you add TLS):
   - VCN → Security List → add an **Ingress Rule**: Source `0.0.0.0/0`,
     TCP destination port **3000**.
   - Also open it in the OS firewall (step 3 below).

## 2. Install Docker on the VM

```bash
ssh ubuntu@<your-vm-public-ip>

sudo apt-get update
sudo apt-get install -y docker.io docker-compose-v2 git
sudo systemctl enable --now docker
sudo usermod -aG docker $USER
# log out and back in so the group change applies
exit
ssh ubuntu@<your-vm-public-ip>
```

## 3. Open the OS firewall for port 3000

Oracle Ubuntu images block ports by default via iptables:

```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 3000 -j ACCEPT
sudo netfilter-persistent save   # persist across reboots
```

## 4. Get the code onto the VM

Either `git clone` your repo, or copy the project up with `scp`:

```bash
# from your laptop, in the project's parent dir:
scp -r whatsapp-sender ubuntu@<your-vm-public-ip>:~/
```

## 5. Set the access password

The app is protected by HTTP Basic Auth whenever `APP_PASSWORD` is set. On the VM:

```bash
cd ~/whatsapp-sender
cp .env.example .env
# generate a strong password and put it in .env
echo "APP_USER=admin" > .env
echo "APP_PASSWORD=$(openssl rand -base64 24)" >> .env
cat .env     # note the password down somewhere safe
```

## 6. Build and run

```bash
docker compose build        # first build downloads Chromium + deps (~1–2 min)
docker compose up -d
docker compose logs -f      # watch startup
```

You should see:
```
Access control: enabled (HTTP Basic Auth).
WhatsApp Contact Sender running at http://localhost:3000
```

## 7. Use it

Open `http://<your-vm-public-ip>:3000` in your browser. It will prompt for the
username/password from your `.env`. Then: connect WhatsApp, scan the QR, and send.

The WhatsApp session is stored in the named Docker volume `wa_auth`, so it
survives `docker compose restart`, reboots, and `docker compose up` after a
rebuild — you won't need to re-scan the QR each time.

---

## Strongly recommended: add HTTPS

Basic Auth over plain HTTP sends your password in base64 (not encrypted). For a
public URL, put a TLS-terminating proxy in front. Easiest is **Caddy**, which
gets a free Let's Encrypt cert automatically if you point a domain at the VM:

```bash
# /etc/caddy/Caddyfile  (after `sudo apt-get install -y caddy`)
yourdomain.example.com {
    reverse_proxy localhost:3000
}
```

Then close port 3000 to the public and only expose 443.

---

## Useful commands

```bash
docker compose logs -f           # live logs (watch for WhatsApp sync %)
docker compose restart           # restart app (session persists)
docker compose down              # stop (session persists in the volume)
docker compose down -v           # stop AND wipe the WhatsApp session volume
docker compose up -d --build     # rebuild after code changes
```

## Troubleshooting

- **Stuck at "authenticated", never "ready":** watch `docker compose logs -f` for
  `[wa] loading NN%` lines. First sync can take a couple of minutes. If it never
  progresses, your WhatsApp Web version may have drifted — bump `whatsapp-web.js`
  in `package.json` and rebuild.
- **Chromium crashes / "Failed to launch the browser process":** usually low
  memory or missing `/dev/shm`. The compose file already sets `shm_size: 1gb`.
  Make sure the VM has ≥ 2 GB RAM free.
- **Number gets banned:** this uses unofficial automation. Keep the per-message
  delay, send only to people expecting your messages, and avoid large batches.
