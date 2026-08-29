var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/rbush/rbush.min.js
var require_rbush_min = __commonJS({
  "node_modules/rbush/rbush.min.js"(exports, module) {
    !(function(t, i) {
      "object" == typeof exports && "undefined" != typeof module ? module.exports = i() : "function" == typeof define && define.amd ? define(i) : (t = t || self).RBush = i();
    })(exports, function() {
      "use strict";
      function t(t2, r2, e2, a2, h2) {
        !(function t3(n2, r3, e3, a3, h3) {
          for (; a3 > e3; ) {
            if (a3 - e3 > 600) {
              var o2 = a3 - e3 + 1, s2 = r3 - e3 + 1, l2 = Math.log(o2), f2 = 0.5 * Math.exp(2 * l2 / 3), u2 = 0.5 * Math.sqrt(l2 * f2 * (o2 - f2) / o2) * (s2 - o2 / 2 < 0 ? -1 : 1), m2 = Math.max(e3, Math.floor(r3 - s2 * f2 / o2 + u2)), c2 = Math.min(a3, Math.floor(r3 + (o2 - s2) * f2 / o2 + u2));
              t3(n2, r3, m2, c2, h3);
            }
            var p2 = n2[r3], d2 = e3, x = a3;
            for (i(n2, e3, r3), h3(n2[a3], p2) > 0 && i(n2, e3, a3); d2 < x; ) {
              for (i(n2, d2, x), d2++, x--; h3(n2[d2], p2) < 0; ) d2++;
              for (; h3(n2[x], p2) > 0; ) x--;
            }
            0 === h3(n2[e3], p2) ? i(n2, e3, x) : i(n2, ++x, a3), x <= r3 && (e3 = x + 1), r3 <= x && (a3 = x - 1);
          }
        })(t2, r2, e2 || 0, a2 || t2.length - 1, h2 || n);
      }
      function i(t2, i2, n2) {
        var r2 = t2[i2];
        t2[i2] = t2[n2], t2[n2] = r2;
      }
      function n(t2, i2) {
        return t2 < i2 ? -1 : t2 > i2 ? 1 : 0;
      }
      var r = function(t2) {
        void 0 === t2 && (t2 = 9), this._maxEntries = Math.max(4, t2), this._minEntries = Math.max(2, Math.ceil(0.4 * this._maxEntries)), this.clear();
      };
      function e(t2, i2, n2) {
        if (!n2) return i2.indexOf(t2);
        for (var r2 = 0; r2 < i2.length; r2++) if (n2(t2, i2[r2])) return r2;
        return -1;
      }
      function a(t2, i2) {
        h(t2, 0, t2.children.length, i2, t2);
      }
      function h(t2, i2, n2, r2, e2) {
        e2 || (e2 = p(null)), e2.minX = 1 / 0, e2.minY = 1 / 0, e2.maxX = -1 / 0, e2.maxY = -1 / 0;
        for (var a2 = i2; a2 < n2; a2++) {
          var h2 = t2.children[a2];
          o(e2, t2.leaf ? r2(h2) : h2);
        }
        return e2;
      }
      function o(t2, i2) {
        return t2.minX = Math.min(t2.minX, i2.minX), t2.minY = Math.min(t2.minY, i2.minY), t2.maxX = Math.max(t2.maxX, i2.maxX), t2.maxY = Math.max(t2.maxY, i2.maxY), t2;
      }
      function s(t2, i2) {
        return t2.minX - i2.minX;
      }
      function l(t2, i2) {
        return t2.minY - i2.minY;
      }
      function f(t2) {
        return (t2.maxX - t2.minX) * (t2.maxY - t2.minY);
      }
      function u(t2) {
        return t2.maxX - t2.minX + (t2.maxY - t2.minY);
      }
      function m(t2, i2) {
        return t2.minX <= i2.minX && t2.minY <= i2.minY && i2.maxX <= t2.maxX && i2.maxY <= t2.maxY;
      }
      function c(t2, i2) {
        return i2.minX <= t2.maxX && i2.minY <= t2.maxY && i2.maxX >= t2.minX && i2.maxY >= t2.minY;
      }
      function p(t2) {
        return { children: t2, height: 1, leaf: true, minX: 1 / 0, minY: 1 / 0, maxX: -1 / 0, maxY: -1 / 0 };
      }
      function d(i2, n2, r2, e2, a2) {
        for (var h2 = [n2, r2]; h2.length; ) if (!((r2 = h2.pop()) - (n2 = h2.pop()) <= e2)) {
          var o2 = n2 + Math.ceil((r2 - n2) / e2 / 2) * e2;
          t(i2, o2, n2, r2, a2), h2.push(n2, o2, o2, r2);
        }
      }
      return r.prototype.all = function() {
        return this._all(this.data, []);
      }, r.prototype.search = function(t2) {
        var i2 = this.data, n2 = [];
        if (!c(t2, i2)) return n2;
        for (var r2 = this.toBBox, e2 = []; i2; ) {
          for (var a2 = 0; a2 < i2.children.length; a2++) {
            var h2 = i2.children[a2], o2 = i2.leaf ? r2(h2) : h2;
            c(t2, o2) && (i2.leaf ? n2.push(h2) : m(t2, o2) ? this._all(h2, n2) : e2.push(h2));
          }
          i2 = e2.pop();
        }
        return n2;
      }, r.prototype.collides = function(t2) {
        var i2 = this.data;
        if (!c(t2, i2)) return false;
        for (var n2 = []; i2; ) {
          for (var r2 = 0; r2 < i2.children.length; r2++) {
            var e2 = i2.children[r2], a2 = i2.leaf ? this.toBBox(e2) : e2;
            if (c(t2, a2)) {
              if (i2.leaf || m(t2, a2)) return true;
              n2.push(e2);
            }
          }
          i2 = n2.pop();
        }
        return false;
      }, r.prototype.load = function(t2) {
        if (!t2 || !t2.length) return this;
        if (t2.length < this._minEntries) {
          for (var i2 = 0; i2 < t2.length; i2++) this.insert(t2[i2]);
          return this;
        }
        var n2 = this._build(t2.slice(), 0, t2.length - 1, 0);
        if (this.data.children.length) if (this.data.height === n2.height) this._splitRoot(this.data, n2);
        else {
          if (this.data.height < n2.height) {
            var r2 = this.data;
            this.data = n2, n2 = r2;
          }
          this._insert(n2, this.data.height - n2.height - 1, true);
        }
        else this.data = n2;
        return this;
      }, r.prototype.insert = function(t2) {
        return t2 && this._insert(t2, this.data.height - 1), this;
      }, r.prototype.clear = function() {
        return this.data = p([]), this;
      }, r.prototype.remove = function(t2, i2) {
        if (!t2) return this;
        for (var n2, r2, a2, h2 = this.data, o2 = this.toBBox(t2), s2 = [], l2 = []; h2 || s2.length; ) {
          if (h2 || (h2 = s2.pop(), r2 = s2[s2.length - 1], n2 = l2.pop(), a2 = true), h2.leaf) {
            var f2 = e(t2, h2.children, i2);
            if (-1 !== f2) return h2.children.splice(f2, 1), s2.push(h2), this._condense(s2), this;
          }
          a2 || h2.leaf || !m(h2, o2) ? r2 ? (n2++, h2 = r2.children[n2], a2 = false) : h2 = null : (s2.push(h2), l2.push(n2), n2 = 0, r2 = h2, h2 = h2.children[0]);
        }
        return this;
      }, r.prototype.toBBox = function(t2) {
        return t2;
      }, r.prototype.compareMinX = function(t2, i2) {
        return t2.minX - i2.minX;
      }, r.prototype.compareMinY = function(t2, i2) {
        return t2.minY - i2.minY;
      }, r.prototype.toJSON = function() {
        return this.data;
      }, r.prototype.fromJSON = function(t2) {
        return this.data = t2, this;
      }, r.prototype._all = function(t2, i2) {
        for (var n2 = []; t2; ) t2.leaf ? i2.push.apply(i2, t2.children) : n2.push.apply(n2, t2.children), t2 = n2.pop();
        return i2;
      }, r.prototype._build = function(t2, i2, n2, r2) {
        var e2, h2 = n2 - i2 + 1, o2 = this._maxEntries;
        if (h2 <= o2) return a(e2 = p(t2.slice(i2, n2 + 1)), this.toBBox), e2;
        r2 || (r2 = Math.ceil(Math.log(h2) / Math.log(o2)), o2 = Math.ceil(h2 / Math.pow(o2, r2 - 1))), (e2 = p([])).leaf = false, e2.height = r2;
        var s2 = Math.ceil(h2 / o2), l2 = s2 * Math.ceil(Math.sqrt(o2));
        d(t2, i2, n2, l2, this.compareMinX);
        for (var f2 = i2; f2 <= n2; f2 += l2) {
          var u2 = Math.min(f2 + l2 - 1, n2);
          d(t2, f2, u2, s2, this.compareMinY);
          for (var m2 = f2; m2 <= u2; m2 += s2) {
            var c2 = Math.min(m2 + s2 - 1, u2);
            e2.children.push(this._build(t2, m2, c2, r2 - 1));
          }
        }
        return a(e2, this.toBBox), e2;
      }, r.prototype._chooseSubtree = function(t2, i2, n2, r2) {
        for (; r2.push(i2), !i2.leaf && r2.length - 1 !== n2; ) {
          for (var e2 = 1 / 0, a2 = 1 / 0, h2 = void 0, o2 = 0; o2 < i2.children.length; o2++) {
            var s2 = i2.children[o2], l2 = f(s2), u2 = (m2 = t2, c2 = s2, (Math.max(c2.maxX, m2.maxX) - Math.min(c2.minX, m2.minX)) * (Math.max(c2.maxY, m2.maxY) - Math.min(c2.minY, m2.minY)) - l2);
            u2 < a2 ? (a2 = u2, e2 = l2 < e2 ? l2 : e2, h2 = s2) : u2 === a2 && l2 < e2 && (e2 = l2, h2 = s2);
          }
          i2 = h2 || i2.children[0];
        }
        var m2, c2;
        return i2;
      }, r.prototype._insert = function(t2, i2, n2) {
        var r2 = n2 ? t2 : this.toBBox(t2), e2 = [], a2 = this._chooseSubtree(r2, this.data, i2, e2);
        for (a2.children.push(t2), o(a2, r2); i2 >= 0 && e2[i2].children.length > this._maxEntries; ) this._split(e2, i2), i2--;
        this._adjustParentBBoxes(r2, e2, i2);
      }, r.prototype._split = function(t2, i2) {
        var n2 = t2[i2], r2 = n2.children.length, e2 = this._minEntries;
        this._chooseSplitAxis(n2, e2, r2);
        var h2 = this._chooseSplitIndex(n2, e2, r2), o2 = p(n2.children.splice(h2, n2.children.length - h2));
        o2.height = n2.height, o2.leaf = n2.leaf, a(n2, this.toBBox), a(o2, this.toBBox), i2 ? t2[i2 - 1].children.push(o2) : this._splitRoot(n2, o2);
      }, r.prototype._splitRoot = function(t2, i2) {
        this.data = p([t2, i2]), this.data.height = t2.height + 1, this.data.leaf = false, a(this.data, this.toBBox);
      }, r.prototype._chooseSplitIndex = function(t2, i2, n2) {
        for (var r2, e2, a2, o2, s2, l2, u2, m2 = 1 / 0, c2 = 1 / 0, p2 = i2; p2 <= n2 - i2; p2++) {
          var d2 = h(t2, 0, p2, this.toBBox), x = h(t2, p2, n2, this.toBBox), v = (e2 = d2, a2 = x, o2 = void 0, s2 = void 0, l2 = void 0, u2 = void 0, o2 = Math.max(e2.minX, a2.minX), s2 = Math.max(e2.minY, a2.minY), l2 = Math.min(e2.maxX, a2.maxX), u2 = Math.min(e2.maxY, a2.maxY), Math.max(0, l2 - o2) * Math.max(0, u2 - s2)), M = f(d2) + f(x);
          v < m2 ? (m2 = v, r2 = p2, c2 = M < c2 ? M : c2) : v === m2 && M < c2 && (c2 = M, r2 = p2);
        }
        return r2 || n2 - i2;
      }, r.prototype._chooseSplitAxis = function(t2, i2, n2) {
        var r2 = t2.leaf ? this.compareMinX : s, e2 = t2.leaf ? this.compareMinY : l;
        this._allDistMargin(t2, i2, n2, r2) < this._allDistMargin(t2, i2, n2, e2) && t2.children.sort(r2);
      }, r.prototype._allDistMargin = function(t2, i2, n2, r2) {
        t2.children.sort(r2);
        for (var e2 = this.toBBox, a2 = h(t2, 0, i2, e2), s2 = h(t2, n2 - i2, n2, e2), l2 = u(a2) + u(s2), f2 = i2; f2 < n2 - i2; f2++) {
          var m2 = t2.children[f2];
          o(a2, t2.leaf ? e2(m2) : m2), l2 += u(a2);
        }
        for (var c2 = n2 - i2 - 1; c2 >= i2; c2--) {
          var p2 = t2.children[c2];
          o(s2, t2.leaf ? e2(p2) : p2), l2 += u(s2);
        }
        return l2;
      }, r.prototype._adjustParentBBoxes = function(t2, i2, n2) {
        for (var r2 = n2; r2 >= 0; r2--) o(i2[r2], t2);
      }, r.prototype._condense = function(t2) {
        for (var i2 = t2.length - 1, n2 = void 0; i2 >= 0; i2--) 0 === t2[i2].children.length ? i2 > 0 ? (n2 = t2[i2 - 1].children).splice(n2.indexOf(t2[i2]), 1) : this.clear() : a(t2[i2], this.toBBox);
      }, r;
    });
  }
});

// packages/editor/src/lib/editor/managers/SpatialIndexManager/RBushIndex.ts
var import_rbush = __toESM(require_rbush_min(), 1);
var TldrawRBush = class extends import_rbush.default {
};
var RBushIndex = class {
  rBush;
  elementsInTree;
  constructor() {
    this.rBush = new TldrawRBush();
    this.elementsInTree = /* @__PURE__ */ new Map();
  }
  /**
   * Search for shapes within the given bounds.
   * Returns set of shape IDs that intersect with the bounds.
   */
  search(bounds) {
    const results = this.rBush.search({
      minX: bounds.minX,
      minY: bounds.minY,
      maxX: bounds.maxX,
      maxY: bounds.maxY
    });
    return new Set(results.map((e) => e.id));
  }
  /**
   * Remove a shape from the spatial index.
   */
  remove(id) {
    const element = this.elementsInTree.get(id);
    if (element) {
      this.rBush.remove(element);
      this.elementsInTree.delete(id);
    }
  }
  /**
   * Apply the removals and upserts collected during one incremental update.
   * Mutations are applied per item: bulk-rebuilding the whole tree instead
   * was measured slower even with ~10% of the index in the batch.
   */
  applyBatch(removes, upserts) {
    for (const id of removes) {
      this.remove(id);
    }
    for (const element of upserts) {
      const existing = this.elementsInTree.get(element.id);
      if (existing) {
        this.rBush.remove(existing);
      }
      this.rBush.insert(element);
      this.elementsInTree.set(element.id, element);
    }
  }
  /**
   * Bulk load elements into the spatial index.
   * More efficient than individual inserts for initial loading.
   */
  bulkLoad(elements) {
    this.rBush.load(elements);
    for (const element of elements) {
      this.elementsInTree.set(element.id, element);
    }
  }
  /**
   * Clear all elements from the spatial index.
   */
  clear() {
    this.rBush.clear();
    this.elementsInTree.clear();
  }
  /**
   * Check if a shape is in the spatial index.
   */
  has(id) {
    return this.elementsInTree.has(id);
  }
  /**
   * Get the number of elements in the spatial index.
   */
  getSize() {
    return this.elementsInTree.size;
  }
  /**
   * Get the raw stored element for a shape, without allocating a Box.
   * Use when you only need to read the indexed bounds for comparison.
   *
   * @internal
   */
  getElement(id) {
    return this.elementsInTree.get(id);
  }
  /**
   * Dispose of the spatial index.
   * Clears all data structures to prevent memory leaks.
   */
  dispose() {
    this.clear();
  }
};
export {
  RBushIndex
};
