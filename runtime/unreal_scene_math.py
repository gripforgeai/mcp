"""Renderer-independent scene transforms used by the Unreal scene worker (metres, Y up)."""
import math


def exposure_brightness(ev100, extended_range):
    """UE's same property means EV100 in extended projects, luminance in legacy projects."""
    return ev100 if extended_range else 2.0 ** ev100


def identity():
    return [[1 if i == j else 0 for j in range(4)] for i in range(4)]


def multiply(a, b):
    return [[sum(a[i][k] * b[k][j] for k in range(4)) for j in range(4)] for i in range(4)]


def matrix(transform):
    t, q, s = (transform[k] for k in ('translation', 'rotation', 'scale'))
    x, y, z, w = (q[k] for k in 'xyzw')
    length = math.sqrt(x*x + y*y + z*z + w*w)
    if length < 1e-9:
        raise ValueError('Zero scene quaternion')
    x, y, z, w = (v / length for v in (x, y, z, w))
    r = [[1-2*(y*y+z*z), 2*(x*y-z*w), 2*(x*z+y*w), t['x']],
         [2*(x*y+z*w), 1-2*(x*x+z*z), 2*(y*z-x*w), t['y']],
         [2*(x*z-y*w), 2*(y*z+x*w), 1-2*(x*x+y*y), t['z']], [0, 0, 0, 1]]
    for i in range(3):
        for j, key in enumerate('xyz'):
            r[i][j] *= s[key]
    return r


def world_matrices(nodes):
    by_id, done, visiting = {n['id']: n for n in nodes}, {}, set()
    def visit(key):
        if key in done:
            return done[key]
        if key in visiting:
            raise ValueError('Cyclic scene hierarchy at ' + key)
        visiting.add(key)
        node = by_id[key]
        parent = visit(node['parentId']) if node.get('parentId') else identity()
        done[key] = multiply(parent, matrix(node['transform']))
        visiting.remove(key)
        return done[key]
    for node in nodes:
        visit(node['id'])
    return done


def point(m, p):
    return [sum(m[i][j] * p[j] for j in range(3)) + m[i][3] for i in range(3)]


def ue_matrix(m):
    # Same axis conversion as Unreal's GLTFCore importer: (x, y, z) -> (x, z, y).
    order = [0, 2, 1, 3]
    converted = [[m[order[i]][order[j]] for j in range(4)] for i in range(4)]
    for i in range(3):
        converted[i][3] *= 100
    return converted


def decompose(m):
    s = [math.sqrt(sum(m[i][j]**2 for i in range(3))) for j in range(3)]
    if min(s) < 1e-8:
        raise ValueError('Zero-scale scene instance')
    det = (m[0][0]*(m[1][1]*m[2][2]-m[1][2]*m[2][1])
           - m[0][1]*(m[1][0]*m[2][2]-m[1][2]*m[2][0])
           + m[0][2]*(m[1][0]*m[2][1]-m[1][1]*m[2][0]))
    if det < 0:
        s[0] *= -1
    r = [[m[i][j] / s[j] for j in range(3)] for i in range(3)]
    if any(abs(sum(r[k][i]*r[k][j] for k in range(3))) > 1e-4 for i in range(3) for j in range(i+1, 3)):
        raise ValueError('Sheared hierarchy requires baking geometry before Unreal import')
    trace = sum(r[i][i] for i in range(3))
    if trace > 0:
        k = math.sqrt(trace+1)*2
        q = [(r[2][1]-r[1][2])/k, (r[0][2]-r[2][0])/k, (r[1][0]-r[0][1])/k, k/4]
    else:
        i = max(range(3), key=lambda a: r[a][a]); j, h = (i+1)%3, (i+2)%3
        k = math.sqrt(1+r[i][i]-r[j][j]-r[h][h])*2
        q = [0, 0, 0, (r[h][j]-r[j][h])/k]
        q[i], q[j], q[h] = k/4, (r[j][i]+r[i][j])/k, (r[h][i]+r[i][h])/k
    return [m[i][3] for i in range(3)], q, s


def native_transform(scene_matrix, source=None):
    m = ue_matrix(scene_matrix)
    if source and source.get('pivot') == 'bounds_base':
        origin, extent = source['origin'], source['extent']
        anchor = [origin[0], origin[1], origin[2]-extent[2]]
        for i in range(3):
            m[i][3] -= sum(m[i][j] * anchor[j] for j in range(3))
    return decompose(m)
