const chainProxy = require('async-chain-proxy')

const {
  TimeoutError,
  WaitTimeoutError,
  EvaluateTimeoutError,
  EvaluateError,
} = require('./error')
const {
  wrapFunctionForEvaluation,
  wrapFunctionForCallFunction,
} = require('./functionToSource')
const {
  escapeHtml,
  escapeSingleQuote,
} = require('./util')

class Document {
  constructor (chromy, client, nodeId = null) {
    if (chromy) {
      this.chromy = chromy
    } else {
      this.chromy = this
    }
    this.client = client
    this.nodeId = nodeId
    this._originalNodeId = nodeId
  }

  chain (options = {}) {
    return chainProxy(this, options)
  }

  async iframe (selector, callback) {
    const rect = await this.getBoundingClientRect(selector)
    if (!rect) {
      return Promise.resolve()
    }
    // to get the the node for location, a position of the node must be in a viewport.
    const originalPageOffset = await this._getPageOffset()
    let doc = null
    try {
      await this.scrollTo(0, rect.top)
      const locationParams = {x: rect.left + 10, y: rect.top + 10}
      const {nodeId: iframeNodeId} = await this.client.DOM.getNodeForLocation(locationParams)
      if (!iframeNodeId) {
        return Promise.resolve()
      }
      doc = new Document(this.chromy, this.client, iframeNodeId)
      doc._activateOnDocumentUpdatedListener()
    } finally {
      // restore scroll potion.
      await this.scrollTo(originalPageOffset.x, originalPageOffset.y)
    }
    return Promise.resolve(callback.apply(this, [doc]))
  }

  async click (expr, inputOptions = {}) {
    const defaults = {waitLoadEvent: false}
    const options = Object.assign({}, defaults, inputOptions)
    let promise = null
    if (options.waitLoadEvent) {
      promise = this.waitLoadEvent()
    }
    let nid = await this._getNodeId()
    let evalExpr = 'document.querySelectorAll(\'' + escapeSingleQuote(expr) + '\').forEach(n => n.click())'
    if (this._originalNodeId) {
      await this._evaluateOnNode(nid, evalExpr)
    } else {
      await this.evaluate(evalExpr)
    }
    if (promise !== null) {
      await promise
    }
  }

  async insert (expr, value) {
    expr = escapeSingleQuote(expr)
    await this.evaluate('document.querySelector(\'' + expr + '\').focus()')
    await this.evaluate('document.querySelector(\'' + expr + '\').value = "' + escapeHtml(value) + '"')
  }

  async check (selector) {
    await this.evaluate('document.querySelectorAll(\'' + escapeSingleQuote(selector) + '\').forEach(n => n.checked = true)')
  }

  async uncheck (selector) {
    await this.evaluate('document.querySelectorAll(\'' + escapeSingleQuote(selector) + '\').forEach(n => n.checked = false)')
  }

  async select (selector, value) {
    let sel = escapeSingleQuote(selector)
    const src = `
      document.querySelectorAll('${sel} > option').forEach(n => {
        if (n.value === "${value}") {
          n.selected = true
        }
      })
      `
    await this.evaluate(src)
  }

  async scroll (x, y) {
    return this._evaluateWithReplaces(function () {
      const dx = _1  // eslint-disable-line no-undef
      const dy = _2  // eslint-disable-line no-undef
      window.scrollTo(window.pageXOffset + dx, window.pageYOffset + dy)
    }, {}, {'_1': x, '_2': y})
  }

  async scrollTo (x, y) {
    return this._evaluateWithReplaces(function () {
      window.scrollTo(_1, _2) // eslint-disable-line no-undef
    }, {}, {'_1': x, '_2': y})
  }

  async _getPageOffset () {
    return this.evaluate(_ => {
      return {
        x: window.pageXOffset,
        y: window.pageYOffset,
      }
    })
  }

  async evaluate (expr, options = {}) {
    return await this._evaluateWithReplaces(expr, options)
  }

  async _evaluateWithReplaces (expr, options = {}, replaces = {}) {
    let e = null
    if (this._originalNodeId) {
      e = wrapFunctionForCallFunction(expr, replaces)
    } else {
      e = wrapFunctionForEvaluation(expr, replaces)
    }
    try {
      let result = await this._waitFinish(this.chromy.options.evaluateTimeout, async () => {
        if (!this.client) {
          return null
        }
        if (this._originalNodeId) {
          // must call callFunctionOn() for evaluating expression with iframe context.
          const contextNodeId = await this._getNodeId()
          const objectId = await this._getObjectIdFromNodeId(contextNodeId)
          const params = Object.assign({}, options, {objectId: objectId, functionDeclaration: e})
          return await this.client.Runtime.callFunctionOn(params)
        } else {
          return await this.client.Runtime.evaluate({expression: e})
        }
      })
      if (!result || !result.result) {
        return null
      }
      // resolve a promise
      if (result.result.subtype === 'promise') {
        result = await this.client.Runtime.awaitPromise({promiseObjectId: result.result.objectId, returnByValue: true})
        // adjust to after process
        result.result.value = JSON.stringify({
          type: (typeof result.result.value),
          result: JSON.stringify(result.result.value),
        })
      }
      if (result.result.subtype === 'error') {
        throw new EvaluateError('An error has occurred evaluating the script in the browser.' + result.result.description, result.result)
      }
      const resultObject = JSON.parse(result.result.value)
      const type = resultObject.type
      if (type === 'undefined') {
        return undefined
      } else {
        try {
          return JSON.parse(resultObject.result)
        } catch (e) {
          console.log('ERROR', resultObject)
          throw e
        }
      }
    } catch (e) {
      if (e instanceof TimeoutError) {
        throw new EvaluateTimeoutError('evaluate() timeout')
      } else {
        throw e
      }
    }
  }

  // evaluate a function on the specified node context.
  async _evaluateOnNode (nodeId, fn) {
    const objectId = await this._getObjectIdFromNodeId(nodeId)
    const src = fn.toString()
    const functionDeclaration = `function () {
      return (${src})()
    }`
    const params = {
      objectId,
      functionDeclaration,
    }
    await this.client.Runtime.enable()
    await this.client.Runtime.callFunctionOn(params)
  }

  async exists (selector) {
    return this._evaluateWithReplaces(
      _ => { return document.querySelector('?') !== null },
      {}, {'?': escapeSingleQuote(selector)},
    )
  }

  async visible (selector) {
    return this._evaluateWithReplaces(
      _ => {
        let dom = document.querySelector('?')
        return dom !== null && dom.offsetWidth > 0 && dom.offsetHeight > 0
      },
      {}, {'?': escapeSingleQuote(selector)},
    )
  }

  async wait (cond) {
    if ((typeof cond) === 'number') {
      await this.sleep(cond)
    } else if ((typeof cond) === 'function') {
      await this._waitFunction(cond)
    } else {
      await this._waitSelector(cond)
    }
  }

  // wait for func to return true.
  async _waitFunction (func) {
    await this._waitFinish(this.chromy.options.waitTimeout, async () => {
      while (true) {
        const r = await this.evaluate(func)
        if (r) {
          break
        }
        await this.sleep(this.chromy.options.waitFunctionPollingInterval)
      }
    })
  }

  async _waitSelector (selector) {
    let check = null
    let startTime = Date.now()
    await new Promise((resolve, reject) => {
      check = () => {
        setTimeout(async () => {
          try {
            const now = Date.now()
            if (now - startTime > this.chromy.options.waitTimeout) {
              reject(new WaitTimeoutError('wait() timeout'))
              return
            }
            const result = await this.exists(selector)
            if (result) {
              resolve(result)
            } else {
              check()
            }
          } catch (e) {
            reject(e)
          }
        }, this.chromy.options.waitFunctionPollingInterval)
      }
      check()
    })
  }

  async _waitFinish (timeout, callback) {
    const start = Date.now()
    let finished = false
    let error = null
    let result = null
    const f = async () => {
      try {
        result = await callback.apply()
        finished = true
        return result
      } catch (e) {
        error = e
        finished = true
      }
    }
    f.apply()
    while (!finished) {
      const now = Date.now()
      if ((now - start) > timeout) {
        throw new TimeoutError('timeout')
      }
      await this.sleep(this.chromy.options.waitFunctionPollingInterval)
    }
    if (error !== null) {
      throw error
    }
    return result
  }

  async type (expr, value) {
    await this.evaluate('document.querySelector(\'' + escapeSingleQuote(expr) + '\').focus()')
    const characters = value.split('')
    for (let i in characters) {
      const c = characters[i]
      await this.client.Input.dispatchKeyEvent({type: 'char', text: c})
      await this.sleep(this.chromy.options.typeInterval)
    }
  }

  async sleep (msec) {
    await new Promise((resolve, reject) => {
      setTimeout(() => {
        resolve()
      }, msec)
    })
  }

  // deprecated
  async getBoundingClientRect (selector) {
    return this.rect(selector)
  }

  async rect (selector) {
    const rect = await this._evaluateWithReplaces(function () {
      let dom = document.querySelector('?')
      if (!dom) {
        return null
      }
      let r = dom.getBoundingClientRect()
      return {top: r.top, left: r.left, width: r.width, height: r.height}
    }, {}, {'?': escapeSingleQuote(selector)})
    if (!rect) {
      return null
    }
    return {
      top: Math.floor(rect.top),
      left: Math.floor(rect.left),
      width: Math.floor(rect.width),
      height: Math.floor(rect.height),
    }
  }

  async rectAll (selector) {
    const rects = await this._evaluateWithReplaces(function () {
      let doms = document.querySelectorAll('?')
      return Array.prototype.map.call(doms, dom => {
        let r = dom.getBoundingClientRect()
        return {top: r.top, left: r.left, width: r.width, height: r.height}
      })
    }, {}, {'?': escapeSingleQuote(selector)})
    return rects.map(rect => {
      return {
        top: Math.floor(rect.top),
        left: Math.floor(rect.left),
        width: Math.floor(rect.width),
        height: Math.floor(rect.height),
      }
    })
  }

  _activateOnDocumentUpdatedListener () {
    this._onDocumentUpdatedListener = () => {
      this.nodeId = null
    }
    this.client.DOM.documentUpdated(this._onDocumentUpdatedListener)
  }

  async _getObjectIdFromNodeId (nodeId) {
    const {object: rObj} = await this.client.DOM.resolveNode({nodeId})
    if (!rObj) {
      return null
    }
    return rObj.objectId
  }

  async _getNodeId () {
    if (!this.nodeId) {
      let {root} = await this.client.DOM.getDocument()
      this.nodeId = root.nodeId
    }
    return this.nodeId
  }

  async _getScreenInfo () {
    return await this.evaluate(function () {
      return {
        devicePixelRatio: window.devicePixelRatio,
        width: document.body.scrollWidth,
        height: document.body.scrollHeight,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      }
    })
  }

}

module.exports = Document
