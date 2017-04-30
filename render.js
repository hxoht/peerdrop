const dgram = require('dgram')
const os = require('os')
const path = require('path')
const fs = require('fs')
const uuidV4 = require('uuid/v4')
const progress = require('progress-stream')

const dragDrop = require('drag-drop')
const body = require('stream-body')
const { remote, app } = require('electron')
const dialog = remote.dialog
const win = remote.getCurrentWindow()

const httpServer = require('./server')
const httpClient = require('https').request

const client = dgram.createSocket({type: 'udp4', reuseAddr: true})
const server = dgram.createSocket({type: 'udp4', reuseAddr: true})

const PORT = 4321
const MC = '224.0.0.1'

const transfers = {
/*
 * id: {
 *   id,
 *   started,
 *   filename,
 *   filesize,
 *   error: object|null
 *   progress: https://www.npmjs.com/package/progress-stream#progress
 * }
 */
}

function updateTransfer (id, fields) {
  if (!transfers[id]) {
    transfers[id] = fields
  }
  Object.assign(transfers[id], fields)
  if (transfers[id].progress) {
	  console.log(`${Math.round(transfers[id].progress.percentage)}% ­ ${transfers[id].filename}`)
  }
}

function send (o) {
  const message = Buffer.from(JSON.stringify(o))
  client.send(message, 0, message.length, PORT, MC)
}

document.body.classList.add(process.platform)

//
// Dont accept arbitrary drops
//
dragDrop(document.body, () => {})

//
// Advertise a message
//
setInterval(ping, 1500)

function ping (extraAttrs = {}) {
  const attrs = Object.assign({}, {
    event: 'join',
    name: os.hostname().replace(/\.local/g, ''),
    platform: os.platform(),
    ctime: Date.now()
  }, extraAttrs);

  send(attrs);
}

//
// Add a close button
//
const close = document.querySelector('.close')
close.addEventListener('click', () => {
  remote.app.exit()
})

const me = document.querySelector('#me')
try {
  const d = fs.readFileSync(path.join(os.homedir(), 'avatar'))
  me.style.backgroundImage = 'url("' + d + '")'
  me.textContent = ''
} catch (ex) {
  me.textContent = os.hostname()
}

//
// Drop your avatar
//
dragDrop(me, (files) => {
  const reader = new window.FileReader()
  reader.onerror = err => {
    console.error(err)
  }
  reader.onload = e => {
    me.style.backgroundImage = 'url("' + e.target.result + '")'
    me.textContent = ''

    fs.writeFileSync(path.join(os.homedir(), 'avatar'), e.target.result)
    ping({refreshAvatar: true})
  }
  reader.readAsDataURL(files[0])
})

//
// Add our hostname to the `me` icon.
//

httpServer((req, res) => {
  const filename = req.headers['x-filename']

  if (req.url === '/upload') {
    const message = [
      'Do you want to accept the file',
      filename,
      'from',
      req.headers['x-from'] + '?'
    ].join(' ')

    const opts = {
      type: 'question',
      buttons: ['Ok', 'Cancel'],
      title: 'Confirm',
      message
    }

    const result = dialog.showMessageBox(win, opts)

    if (result === 0) {
      const dest = path.join(remote.app.getPath('downloads'), filename)
      const writeStream = fs.createWriteStream(dest)
	  const transfer = {
		  id: uuidV4(),
		  started: Date.now(),
		  filename: req.headers['x-filename'],
		  filesize: req.headers['x-filesize'],
		  from: req.headers['x-from'],
		  error: null,
		  progress: null
	  }
	  updateTransfer(transfer.id, transfer)
      const progressStream = progress({
        length: transfer.filesize,
        time: 500 /* ms */
      })
      progressStream.on('progress', (progress) => {
		  updateTransfer(transfer.id, {progress})
      })
	  console.log(`Staring download from ${transfer.from}, filename: ${transfer.filename}, size ${transfer.filesize} bytes, id ${transfer.id}`)
      req.pipe(progressStream).pipe(writeStream)
    } else if (result === 1) {
      send({
        event: 'reject',
        name: os.hostname().replace(/\.local/g, '')
      })
    }
  } else if (req.url === '/avatar') {
    const filepath = path.join(os.homedir(), 'avatar')
    fs.readFile(filepath, (err, data) => {
      if (err) {
        res.statusCode = 404
        return res.end('')
      }
      res.end(data)
    })
  } else {
    // TODO serve the app so people can download it
  }
})

const registry = {}

function getData (src, cb) {
  const reader = new window.FileReader()
  reader.onerror = err => cb(err)
  reader.onload = e => cb(null, e.target.result)
  reader.readAsArrayBuffer(src)
}

function onFilesDropped (ip, files) {
  files.forEach(file => {
    const opts = {
      host: ip,
      port: 9988,
      path: '/upload',
      method: 'POST',
      rejectUnauthorized: false,
      headers: {
        'Content-Type': file.type,
        'x-filename': file.name,
        'x-from': os.hostname(),
        'x-filesize': file.size
      }
    }

    getData(file, (err, data) => {
      if (err) return console.error(err)
      const req = httpClient(opts, res => {
        if (res.statusCode !== 200) {
          res.on('data', data => {
            console.error(res.statusCode, data)
          })
        }
      })

      req.end(Buffer.from(data))
    })
  })
}

//
// Create a tcp server
//

function joined (msg, rinfo) {
  const me = os.hostname().replace(/\.local/g, '')
  msg.name = msg.name.replace(/\.local/g, '')

  //
  // Don't show me my own machine as a peer
  //
  if (!process.env['DEBUG'] && msg.name === me) {
    return
  }

  //
  // If the peer is already rendered, just return
  //
  const selector = `[data-name="${msg.name}"]`
  if (document.querySelector(selector)) return

  //
  // Otherwise, create a peer and add it to the list.
  //
  const peers = document.querySelector('#peers')
  const peer = document.createElement('div')

  peer.className = 'peer adding adding-anim'
  peer.setAttribute('data-name', msg.name)
  peer.setAttribute('data-ip', rinfo.address)
  peer.setAttribute('data-platform', msg.platform)

  const avatar = document.createElement('div')
  avatar.className = 'avatar ' + msg.platform
  peer.appendChild(avatar)

  const name = document.createElement('address')
  name.textContent = msg.name
  name.title = rinfo.address
  peer.appendChild(name)

  peers.appendChild(peer)

  window.requestAnimationFrame(() => requestAnimationFrame(() => peer.classList.remove('adding')))
  peer.addEventListener('transitionend', e => {
    if (e.propertyName !== 'transform') return
    peer.classList.remove('adding-anim')
  })
  //
  // Add a drag drop event to the peer
  //
  dragDrop(peer, (files) => {
    onFilesDropped(peer.getAttribute('data-ip'), files)
  })

  //
  // Get the avatar from the user who joined
  //
  loadAvatar(rinfo.address, peer)

  //
  // remove inital empty message when finding peers
  //
  const selectorEmptyState = document.querySelector('#empty-message')
  selectorEmptyState.classList.remove('show')
}

function parted (msg) {
  const selector = `.peer[data-name="${msg.name}"]`
  const peer = document.querySelector(selector)
  if (peer) peer.parentNode.removeChild(peer)
}

function cleanUp () {
  for (var key in registry) {
    if (registry[key] && (Date.now() - registry[key].ctime) > 9000) {
      parted(registry[key])
      registry[key] = null
    }
  }
}

server.on('error', (err) => {
  console.error(err)
  server.close()
})

server.on('message', (msg, rinfo) => {
  msg = JSON.parse(msg)
  if (!registry[msg.name] && msg.event === 'join') {
    joined(msg, rinfo)
  }
  if (msg.refreshAvatar) {
    const selector = `.peer[data-name="${msg.name}"]`
    loadAvatar(rinfo.address, document.querySelector(selector));
  }
  registry[msg.name] = msg
})

function loadAvatar (address, peerEl) {
  const opts = {
    host: address,
    port: 9988,
    path: '/avatar',
    rejectUnauthorized: false
  }

  const req = httpClient(opts, res => {
    if (res.statusCode !== 200) {
      return console.error('Unable to get avatar')
    }
    body.parse(res, (err, data) => {
      if (err) return console.error('unable to get avatar')
      peerEl.style.backgroundImage = 'url("' + data + '")'
    })
  })

  req.end()
}

server.on('listening', () => {
  console.log(`Listening on ${PORT}`)
})

server.bind(PORT)

setInterval(cleanUp, 9000)
