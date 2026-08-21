# Podsync Manager Suite v0.7

A self-hosted web manager for turning selected YouTube subscriptions into private Podsync podcast feeds, including classic-iPod-compatible video post-processing.

## Features

- Web Interface
- Connect to your YouTube account
- Select what channels you would like to convert into a podcast
- Select how many episodes and the retention of the files
- Select Audio or iPod Classic Video formats
- Provide RSS URL for you to add into iTunes
- Auto refresh YouTube for new episodes to automatically add


## Fresh install

On an Ubuntu/Debian-style Linux server:

```bash
git clone https://github.com/leedsy/PodSync-Manager.git
cd podsync-manager
sudo bash setup.sh
```

- Open your Browser:
```bash
http://<server-ip>:3000
```

## Update your current version

```bash
cd podsync-manager
git pull
sudo bash update.sh
```



Youtube API Required:
https://console.cloud.google.com/
- Enable Youtube API
- Create oAuth Client ID and Secret
- Application type: TVs and Limited Input devices (This bypasses the need for a URI Redirect)

The installer prints the Manager URL and a generated admin password. Open the URL, sign in, then complete **Setup & Settings** in the browser.

## References

This is a fork of the project: https://github.com/mxpv/podsync
