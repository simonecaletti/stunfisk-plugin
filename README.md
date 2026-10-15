# Stunfisk Coach

Stunfisk Coach is a browser extension for Pokémon Showdown that brings the applications from VGC Lab, and the Stunfisk bot, into the client.
It is its own plugin. It is not part of Showdex and does not need it.
See [adr/](adr/) for the decisions and [OTHERS.md](OTHERS.md) for related projects.

- [common/](common/) holds what every part shares: the settings, the wire formats and the model and engine adapter interfaces.
- [drivers/helper/](drivers/helper/) is the Live Match Helper, the first Coach application.
