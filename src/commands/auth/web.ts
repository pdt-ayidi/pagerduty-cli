import {Command, flags} from '@oclif/command'
import chalk from 'chalk'
import cli from 'cli-ux'
import * as pd from '../../pd'
import * as pdconfig from '../../config'
import * as http from 'http'

import {AuthorizationCode, AuthorizationTokenConfig} from 'simple-oauth2'

export default class AuthWeb extends Command {
  static description = 'Authenticate with PagerDuty in the browser'

  static flags = {
    help: flags.help({char: 'h'}),
  }

  async run() {
    // const {flags} = this.parse(AuthWeb)

    const config = {
      client: {
        id: '4cd1af90cbf22d5d880aafbbb1829835e0a79c7d8811b0a8e87138bd61caf734',
        secret: '4c42b8fffe4cc36ebfff88fa783d842af4cc44e43f7aae5590488d7d3574bebd',
      },
      auth: {
        tokenHost: 'https://app.pagerduty.com',
      },
    }
    const client = new AuthorizationCode(config)

    const state = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15)
    const authorizationUri = client.authorizeURL({
      redirect_uri: 'http://127.0.0.1:8000/callback',
      scope: 'user',
      state: state,
    })

    try {
      await cli.open(authorizationUri)
    } catch (error) {
      this.error(`Couldn't open a browser for web authentication: ${error}`, {
        exit: 1,
        suggestions: [
          `Get a token from ${chalk.bold.blue('https://martindstone.github.io/PDOAuth/')}`,
          `Then run ${chalk.bold.blue('pd auth:set')}`,
        ],
      })
    }

    const server = http.createServer()

    // Maintain a hash of all connected sockets
    const sockets: Record<any, any> = {}
    let nextSocketId = 0
    server.on('connection', function (socket) {
      // Add a newly connected socket
      const socketId = nextSocketId++
      sockets[socketId] = socket

      // Remove the socket when it closes
      socket.on('close', function () {
        delete sockets[socketId]
      })
    })

    server.on('request', (req, res) => {
      // eslint-disable-next-line node/no-unsupported-features/node-builtins
      const urlParts = new URL(req.url, `http://${req.headers.host}`)
      if (urlParts.pathname === '/callback' && urlParts.searchParams.has('code')) {
        const tokenParams: AuthorizationTokenConfig = {
          code: urlParts.searchParams.get('code') as string,
          redirect_uri: 'http://127.0.0.1:8000/callback',
          scope: 'user',
        }
        client.getToken(tokenParams).then(accessToken => {
          if (accessToken && accessToken.token && accessToken.token.access_token) {
            const token = accessToken.token.access_token
            cli.action.start(`Checking token ${chalk.bold.blue(token)}`)
            // sometimes PD gives an error when immediately making a request
            setTimeout(this.checkToken, 2_000, token, this)
          } else {
            cli.action.stop(chalk.bold.red('failed - response didn\'t contain a token'))
            this.error('Missing token', {exit: 1, suggestions: ['Get a token from the web at https://martindstone.github.io/PDOAuth']})
          }
        }, _ => {
          cli.action.stop(chalk.bold.red('grant request failed'))
          this.error('Grant request error', {exit: 1, suggestions: ['Get a token from the web at https://martindstone.github.io/PDOAuth']})
        })

        server.close()
        setTimeout(() => {
          for (const socket of Object.values(sockets)) {
            socket.destroy()
          }
        }, 500)
      }

      res.statusCode = 200
      res.end('\n\n  ok you can close the browser window now')
    })

    try {
      server.listen(8000, () => {
        cli.action.start('Waiting for browser authentication')
      })
    } catch (error) {
      this.error('Couldn\'t start a local server for web authentication', {
        exit: 1,
        suggestions: [
          `Get a token from ${chalk.bold.blue('https://martindstone.github.io/PDOAuth/')}`,
          `Then run ${chalk.bold.blue('pd auth:set')}`,
        ],
      })
    }
  }

  checkToken(token: any, self: any) {
    pd.me(token).then(r => {
      if (r.isFailure) {
        cli.action.stop('failed!')
        self.error(`${r.getPDErrorMessage()}`, {exit: 1, suggestions: ['pd auth:web', 'pd auth:set']})
      }
      const me = r.getValue()
      if (me && me.user && me.user.html_url) {
        const domain = me.user.html_url.match(/https:\/\/(.*)\.pagerduty.com\/.*/)[1]
        pdconfig.setAuth(token)
        cli.action.stop(chalk.bold.green('done'))
        self.log(`You are logged in to ${chalk.bold.blue(domain)} as ${chalk.bold.blue(me.user.email)}`)
      } else {
        cli.action.stop(chalk.bold.red(`failed - got a token (${token}) but it wasn't valid`))
        self.error('Invalid token', {exit: 1, suggestions: ['Get a token from the web at https://martindstone.github.io/PDOAuth']})
      }
    })
  }
}
