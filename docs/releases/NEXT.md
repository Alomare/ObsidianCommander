### Highlights

#### Added Share

Added a **Share** button beside Settings on the war screen. The dialog holds every way to open a war to other players: **LAN**, **Internet** with the confirmation before it opens, and the invite code with **Copy Code** and **New Code**. A chip beside the season shows when a war is open to LAN or to the internet.

#### Added Tunnel Support

Added support for tunnel services such as playit.gg and ngrok, as an alternative to port forwarding. Players type the tunnel address and the invite code under **Join by Address**, the same way as with a forwarded port.

### Changes

- Removed the LAN and Internet switches and the invite code from the bar of the war screen. They are in Share now.
- Evolved wars are on hold: the Evolved War card in **Create War** shows Coming Later and can't be picked. Evolved wars created before still open and play.
- The note about the Windows Firewall prompt sits under LAN in Share, instead of a dialog the first time a war opens to LAN.

### Bug Fixes

- Fixed callers that came through a tunnel program on the host PC counting as local: they reached every war open to LAN without the invite code. They now need **Internet** on and the code, like any caller from outside the network.
