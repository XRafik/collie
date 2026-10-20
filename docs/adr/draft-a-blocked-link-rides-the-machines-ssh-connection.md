# A blocked link rides the Machine's SSH connection

**Status: draft.** Decided by the grill step of run-02b23a78.

It amends:

- [ADR-0057](0057-a-machine-reaches-another-over-a-paired-link.md), on what its
  Considered said about SSH for the link, and on D7's reconnecting;
- [ADR-0044](0044-go-to-pane-opens-the-pane-in-desktop.md), on whose SSH master Go to pane
  rides.

## What was true before

- **A link went only to the peer's port.** The dialling host opened every control link,
  channel and dial-back as a TLS WebSocket to `wss://<HostName>:47217`
  ([ADR-0057](0057-a-machine-reaches-another-over-a-paired-link.md) D3, D5).
- **A network that refuses the port ends the link.** mk-laptop reaches vm-mk through
  Cloudflare WARP, which resets the TLS ClientHello on port 47217. On mk-laptop,
  `collie machine list` stays `connecting` with "refused the control link". vm-mk can never
  reach mk-laptop, so no Run is started or steered across the two. vm-mk's listener is
  healthy: it serves the pinned certificate on `127.0.0.1` and on `10.1.70.29`.
- **SSH to the same Machine works.** herdr's saved machine holds its target, and pairing
  and Desktop already log in with it.
- **SSH was rejected for the link** because every reconnect is an SSO approval on a cego
  VM, so it could not be unattended (ADR-0057, Considered).
- **Desktop held its own master per Machine,** with `ControlPersist=no`, in a temporary
  directory. It closed when Desktop quit.

## Decision

**D1. SSH is only transport.**

- **How the tunnel is made.** The dialling host asks an open SSH connection to the
  Machine to forward a loopback port of its own to the peer's `127.0.0.1:47217`. It then
  dials `wss://127.0.0.1:<port>`.
- **What stays the same:**
  - the pinned certificate, whose names already carry `127.0.0.1`;
  - the bearer secret;
  - the listener and the pairing.
- TLS runs end to end inside the SSH connection, so nothing in `peers.json` changes and
  the listener has one way to authenticate.

**D2. Automatic, with no setting.**

- **Direct first.** Each control-link attempt tries the peer's own URL first, bounded as a
  channel is.
- **Then the tunnel.** Where direct is refused, reset or does not answer, the attempt
  tries the tunnel, if an SSH connection to the Machine is open.
- **One way per link.** Every channel and dial-back of a link goes the way its control
  link came up.
- **Back to direct by itself.** A link up over SSH stays there until it ends. Its next
  connect tries direct again, so a laptop back on a network that lets 47217 through goes
  direct without anyone switching it.

**D3. One SSH connection per Machine on a computer, which ssh keeps.**

- **Where it lives.** Its control path is one the host names under its state directory.
- **How long it stays open.** It is opened as a master with `ControlPersist`, so it
  outlives whatever opened it. A server-alive interval ends one whose network has gone.
- **Everything over SSH shares it:**
  - the link's tunnel;
  - Desktop's SSH route: the bridge, Go to pane, onboarding and a login's port forward;
  - pairing.
- **The cost.** A connection that is lost costs one approval, shared by all of them.
- **Desktop closing leaves it open.** The Flock stays connected with Desktop closed.
- **When it closes.** When herdr no longer lists the Machine, or its target changes, the
  host closes it.

**D4. The host never logs in.**

- **What the host may do.** It uses the connection only through ssh's control commands:
  `check`, `forward`, `cancel` and `exit`. Each one talks to an open master and fails where
  none is open, so none of them can start a login.
- **Who opens a connection.** Only a front door that can show a login, which is
  ADR-0057 D2's rule, kept:
  - **Desktop** opens one when none is open and it needs the Machine's SSH route, or the
    link waits on a connection. It shows its existing "Waiting for SSO login on _name_", as
    it does after a wake today. A Machine whose link goes direct asks for no approval.
  - **A `collie` command** that reaches the Machine while its link waits on an SSH
    connection opens one in its own terminal. Like pairing, it is bounded to two minutes.
- **One way to open one.** `collie machine connect <name>` opens the Machine's connection
  where none is open, and says where it is. Desktop runs it, and so does a command that
  reaches the Machine, so the ssh options and the path are decided in one place.
- **What rides a connection never logs in.** A session sent through the connection, such
  as Desktop's bridge, Go to pane, a script, or pairing's `invite`, is made so it fails
  where the connection has gone. By default, ssh would instead "fall back to connecting
  normally" (`ssh_config(5)`), which here is a second login whose SSO approval nobody
  sees. The front door then opens the connection the one way. The host's control commands
  and these sessions are built in one module, so this is held in one place.
- **Waking the dialler.** A front door that opens the connection tells the host, so the
  link does not wait out its backoff.
- **Who never does.** A host's own jobs never open one: Schedules, settings sync, reports,
  and the dialler itself. While a link waits on a connection, they are refused with
  `machine_unreachable`, which names the connection the link waits on.

**D5. Reconnecting.**

- **What ends a link over SSH.** A sleep, a dropped connection or an SSO session that
  ends each end the SSH connection, and the link with it.
- **How it comes back.** The dialler keeps its backoff. The link comes back:
  - by itself, once direct answers;
  - or once a connection is open again.
- **Without SSO.** SSO approves each new login, so a link over SSH that loses its
  connection stays down until a front door opens one. Usually that is Desktop, after the
  laptop wakes.

**D6. Saying which way, and why.**

- **`collie machine list`, on both sides,** names each live link's transport: `direct`
  or `ssh`. For `ssh`, it also says why direct failed. The dialler says both when it opens
  the control link. The listener never guesses from the address, which is loopback over
  SSH and for a peer on the same computer alike.
- **A link not yet up** says what each way saw:
  - direct's failure;
  - over SSH, either its failure, or that no SSH connection is open and what opens one.
- **`collie doctor`'s paired-links check:**
  - notes a link over SSH, and does not fail it;
  - warns about a link that waits on an SSH connection.
- **Desktop's Machines page** says the transport after "Paired link", with the reason.

## Considered

- **The host logging in itself, throttled.** Rejected. Approvals would be asked when
  nobody asked for one, such as overnight or after a WARP blip. A login nobody answers
  holds the link until it times out.
- **A per-Machine setting (`auto`, `direct`, `ssh`).** Rejected. It is a knob for what the
  failure already tells Collie, as `peer_port` was (ADR-0057).
- **`ssh -W` per channel.** Rejected. Where the master has gone, it falls back to a fresh
  login, so a host job could start one. `-O forward` cannot.
- **A unix-socket forward.** Not possible: Bun's WebSocket client dials only TCP.
- **Ending TLS at sshd** by forwarding to a plain listener. Rejected. It would give the
  listener a second way to authenticate, and the secret would travel without the pin.
- **autossh, or a tunnel daemon of its own.** Rejected. Either one is a new dependency, and
  every restart of it is a login.
- **Desktop keeping its own master beside the host's.** Rejected. It costs two approvals
  per wake: one for Desktop's master and one for the tunnel's.
- **Letting 47217 through WARP** (a split tunnel, or a Gateway policy). This is outside
  Collie. It is the better fix wherever an administrator can make it, and the link goes
  direct again by itself once it is made.

## Consequences

- **The case that started this works.** mk-laptop's link to vm-mk comes up over SSH once
  an SSH connection is open, and vm-mk reaches mk-laptop by dial-back through it.
- **A login stays open after Desktop quits.** One `ssh` process per Machine reached over
  SSH keeps running after Desktop quits, until the connection drops or herdr forgets the
  Machine.
- **Go to pane's terminal outlives Desktop.** It rides that connection, so it no longer
  dies with Desktop's master (amends ADR-0044).
- **One case still waits for a person.** After a laptop sleep with Desktop closed and
  nobody at a terminal, a link over SSH stays down until someone opens a connection. A
  sleeping laptop runs nothing in the meantime anyway.
- **Not decided here:** starting the far host when its listener is down. This is still
  open from ADR-0057.
