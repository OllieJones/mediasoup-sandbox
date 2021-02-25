# Setting up

Make yourself a VM.

Put it into dns

Make a working user.

```shell script
visudo
adduser ollie
adduser ollie sudo
cp -r .ssh ~ollie/
chown -R ollie:ollie ~ollie/.ssh
```

As the newly created user do

```shell script
curl -sL https://deb.nodesource.com/setup_14.x | sudo -E bash -
sudo apt update
sudo apt install -y nodejs build-essential jq htop git python2
sudo apt upgrade
sudo apt-get autoremove
```

Load the demo app.

```shell script
mkdir source
cd source
git clone git@github.com:OllieJones/mediasoup-sandbox.git
cd mediasoup-sandbox
cd single-page
npm install
```

## Utilities and other stuff

```shell script
sudo apt install -y net-tools redis iptraf
```