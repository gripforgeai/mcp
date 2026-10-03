import type { JoystickConfig, JoystickFile } from './index.js';

export function godotJoystickFiles(c: JoystickConfig): JoystickFile[] {
  return [{path:'gripforge/joystick/virtual_stick.gd',content:`extends Control
## GripForge input.joystick: persistent analog state, one pointer per stick.
signal axis_changed(value: Vector2)
@export_range(0.0, 0.5) var deadzone: float = ${c.deadzone}
@export var accent: Color = Color("${c.accent}")
var axis := Vector2.ZERO
var visual := Vector2.ZERO
var pointer := -1

func _ready() -> void:
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	resized.connect(reset)

static func radial(value: Vector2, zone: float) -> Vector2:
	var magnitude := value.length()
	if magnitude <= zone: return Vector2.ZERO
	return value / magnitude * minf(1.0, (magnitude - zone) / (1.0 - zone))

func update_pointer(screen_position: Vector2) -> void:
	var local := get_global_transform_with_canvas().affine_inverse() * screen_position
	var travel := minf(size.x, size.y) * 0.325
	if travel <= 0.0: return
	var raw := (local - size * 0.5) / travel
	visual = raw.limit_length()
	axis = radial(Vector2(raw.x, -raw.y), deadzone)
	axis_changed.emit(axis)
	queue_redraw()

func _input(event: InputEvent) -> void:
	if not is_visible_in_tree():
		reset()
		return
	if event is InputEventScreenTouch:
		if event.canceled and pointer == event.index:
			reset()
			get_viewport().set_input_as_handled()
		elif event.pressed and not event.canceled and pointer == -1 and get_global_rect().has_point(event.position):
			pointer = event.index
			update_pointer(event.position)
			get_viewport().set_input_as_handled()
		elif not event.pressed and pointer == event.index:
			reset()
			get_viewport().set_input_as_handled()
	elif event is InputEventScreenDrag and pointer == event.index:
		update_pointer(event.position)
		get_viewport().set_input_as_handled()
	elif event is InputEventMouseButton and event.button_index == MOUSE_BUTTON_LEFT:
		if event.pressed and pointer == -1 and get_global_rect().has_point(event.position):
			pointer = -2
			update_pointer(event.position)
			get_viewport().set_input_as_handled()
		elif not event.pressed and pointer == -2:
			reset()
			get_viewport().set_input_as_handled()
	elif event is InputEventMouseMotion and pointer == -2:
		update_pointer(event.position)
		get_viewport().set_input_as_handled()

func reset() -> void:
	pointer = -1
	axis = Vector2.ZERO
	visual = Vector2.ZERO
	axis_changed.emit(axis)
	queue_redraw()

func _notification(what: int) -> void:
	if what == NOTIFICATION_APPLICATION_FOCUS_OUT or what == NOTIFICATION_EXIT_TREE:
		reset()

func _draw() -> void:
	var radius := minf(size.x, size.y) * 0.5
	draw_circle(size * 0.5, radius, Color(0.06, 0.08, 0.11, 0.72))
	draw_arc(size * 0.5, maxf(0, radius - 1), 0, TAU, 64, Color(1, 1, 1, 0.22), 2, true)
	draw_circle(size * 0.5 + visual * radius * 0.65, radius * 0.28, accent)
`},{path:'gripforge/joystick/joystick_rig.gd',content:`extends CanvasLayer
## Add this script to a CanvasLayer. No InputMap mutation or autoload required.
const Stick = preload("res://gripforge/joystick/virtual_stick.gd")
@export var dual: bool = ${c.layout==='dual'?'true':'false'}
@export_range(32, 160) var radius: float = ${c.radius}
@export_range(0, 0.5) var deadzone: float = ${c.deadzone}
var left: Control
var right: Control

func _ready() -> void:
	layer = 20
	left = Stick.new()
	left.deadzone = deadzone
	add_child(left)
	if dual:
		right = Stick.new()
		right.deadzone = deadzone
		add_child(right)
	get_viewport().size_changed.connect(_layout)
	_layout()

func _layout() -> void:
	var view := get_viewport().get_visible_rect().size
	var r := minf(radius, maxf(24, (view.x - 72) / (4 if dual else 2)))
	left.size = Vector2.ONE * r * 2
	left.position = Vector2(24, maxf(0, view.y - 24 - r * 2))
	left.reset()
	if right:
		right.size = left.size
		right.position = Vector2(view.x - 24 - r * 2, left.position.y)
		right.reset()

func movement() -> Vector2:
	return left.axis if is_instance_valid(left) else Vector2.ZERO

func look() -> Vector2:
	return right.axis if is_instance_valid(right) else Vector2.ZERO
`},{path:'gripforge/joystick/joystick.tscn',content:`[gd_scene load_steps=2 format=3]
[ext_resource type="Script" path="res://gripforge/joystick/joystick_rig.gd" id="1"]
[node name="GripForgeJoystick" type="CanvasLayer"]
script = ExtResource("1")
`},{path:'gripforge/joystick/character_example.gd',content:`extends CharacterBody3D
## Optional example; merge input reads into your own motor instead of running two motors.
@export var joystick: CanvasLayer
@export var camera: Node3D
@export var speed: float = 5.0
@export var gravity: float = 9.8
func _physics_process(delta: float) -> void:
	var axes: Vector2 = joystick.movement() if joystick else Vector2.ZERO
	var yaw: float = camera.global_rotation.y if camera else global_rotation.y
	var direction := Basis(Vector3.UP, yaw) * Vector3(axes.x, 0, -axes.y)
	velocity.x = direction.x * speed
	velocity.z = direction.z * speed
	if not is_on_floor(): velocity.y -= gravity * delta
	else: velocity.y = 0
	move_and_slide()
`},{path:'README.md',content:`# GripForge joystick · Godot 4.2+

Copy gripforge/ into res://. Instance joystick.tscn in the gameplay scene.
Read movement() and look() every physics frame. X is right; Y is forward/up.
Assign the rig and camera in the optional CharacterBody3D example. A collider and
floor are still supplied by your game; the joystick does not replace collision.

Touch IDs are isolated; both sticks can be held simultaneously. Mouse testing is
built in: you do not need to enable Emulate Touch From Mouse. Keep only one such
emulation path active. Release, focus loss, resizing and removal reset the axes.
The rig does not erase keyboard/gamepad bindings. Combine its movement vector with
your existing input source in your motor (choose one source per frame, then clamp
the combined length to one). Apply look as angular velocity times delta once.
`}];
}
