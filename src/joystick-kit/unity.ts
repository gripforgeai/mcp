import type { JoystickConfig, JoystickFile } from './index.js';

export function unityJoystickFiles(c: JoystickConfig): JoystickFile[] {
  const dir = 'Assets/GripForge/Joystick/';
  return [{path:dir+'GripForgeVirtualStick.cs',content:`using UnityEngine;
using UnityEngine.EventSystems;

namespace GripForge.Inputs {
// One owner per stick; holding a finger does not require new drag events.
public sealed class GripForgeVirtualStick : MonoBehaviour, IPointerDownHandler,
    IDragHandler, IPointerUpHandler, IEndDragHandler, IInitializePotentialDragHandler {
    [Range(0, .5f)] public float Deadzone = ${c.deadzone}f;
    public RectTransform Thumb;
    public Vector2 Axis { get; private set; }
    int? owner;
    RectTransform Rect => (RectTransform)transform;

    public static Vector2 Radial(Vector2 value, float deadzone) {
        float m = value.magnitude;
        if (float.IsNaN(m) || float.IsInfinity(m) || m <= deadzone) return Vector2.zero;
        return value / m * Mathf.Min(1, (m - deadzone) / (1 - deadzone));
    }
    public void OnInitializePotentialDrag(PointerEventData e) { e.useDragThreshold = false; }
    public void OnPointerDown(PointerEventData e) {
        if (owner.HasValue || e.button != PointerEventData.InputButton.Left) return;
        owner = e.pointerId;
        UpdatePointer(e);
    }
    public void OnDrag(PointerEventData e) { if (owner == e.pointerId) UpdatePointer(e); }
    public void OnPointerUp(PointerEventData e) { if (owner == e.pointerId) ResetStick(); }
    public void OnEndDrag(PointerEventData e) { if (owner == e.pointerId) ResetStick(); }
    void UpdatePointer(PointerEventData e) {
        if (!RectTransformUtility.ScreenPointToLocalPointInRectangle(Rect, e.position, e.pressEventCamera, out Vector2 p)) return;
        float travel = Mathf.Min(Rect.rect.width, Rect.rect.height) * .325f;
        if (travel <= 0) { ResetStick(); return; }
        Vector2 raw = (p - Rect.rect.center) / travel;
        Axis = Radial(raw, Deadzone);
        if (Thumb) Thumb.anchoredPosition = Vector2.ClampMagnitude(raw, 1) * travel;
    }
    public void ResetStick() { owner = null; Axis = Vector2.zero; if (Thumb) Thumb.anchoredPosition = Vector2.zero; }
    void OnDisable() { ResetStick(); }
    void OnApplicationFocus(bool focused) { if (!focused) ResetStick(); }
    void OnApplicationPause(bool paused) { if (paused) ResetStick(); }
    void OnRectTransformDimensionsChange() { ResetStick(); }
}
}
`},{path:dir+'GripForgeJoystickRig.cs',content:`using UnityEngine;
using UnityEngine.UI;
using UnityEngine.EventSystems;
#if ENABLE_INPUT_SYSTEM
using UnityEngine.InputSystem.UI;
#endif

namespace GripForge.Inputs {
// Add this component to a scene GameObject. It creates its own UI only.
public sealed class GripForgeJoystickRig : MonoBehaviour {
    public bool Dual = ${c.layout==='dual'?'true':'false'};
    [Range(32, 160)] public float Radius = ${c.radius}f;
    [Range(0, .5f)] public float Deadzone = ${c.deadzone}f;
    public Vector2 Move => left ? left.Axis : Vector2.zero;
    public Vector2 Look => right ? right.Axis : Vector2.zero;
    GripForgeVirtualStick left, right;
    GameObject ui;
    RectTransform safe;
    Rect lastSafe;
    Vector2Int lastScreen;
    Texture2D circleTexture;
    Sprite circle;

    void Awake() {
        circleTexture = new Texture2D(64, 64, TextureFormat.RGBA32, false);
        circleTexture.wrapMode = TextureWrapMode.Clamp;
        for (int y=0;y<64;y++) for (int x=0;x<64;x++) {
            float alpha = Mathf.Clamp01(32 - Vector2.Distance(new Vector2(x+.5f,y+.5f), new Vector2(32,32)));
            circleTexture.SetPixel(x,y,new Color(1,1,1,alpha));
        }
        circleTexture.Apply();
        circle = Sprite.Create(circleTexture,new Rect(0,0,64,64),new Vector2(.5f,.5f),64);
        ui = new GameObject("GripForge Joystick UI",typeof(RectTransform),typeof(Canvas),typeof(CanvasScaler),typeof(GraphicRaycaster));
        ui.transform.SetParent(transform,false);
        ui.GetComponent<Canvas>().renderMode = RenderMode.ScreenSpaceOverlay;
        ui.GetComponent<Canvas>().sortingOrder = 20;
        var scaler = ui.GetComponent<CanvasScaler>();
        scaler.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
        scaler.referenceResolution = new Vector2(1280,720); scaler.matchWidthOrHeight = .5f;
        safe = new GameObject("Safe Area",typeof(RectTransform)).GetComponent<RectTransform>();
        safe.SetParent(ui.transform,false);
        left = MakeStick("Move",false);
        if (Dual) right = MakeStick("Look",true);
        // Reuse the game's EventSystem; do not replace configured input modules.
        if (!FindObjectOfType<EventSystem>()) {
            var events = new GameObject("GripForge EventSystem",typeof(EventSystem));
            events.transform.SetParent(transform,false);
#if ENABLE_INPUT_SYSTEM
            var input = events.AddComponent<InputSystemUIInputModule>();
            input.AssignDefaultActions();
#else
            events.AddComponent<StandaloneInputModule>();
#endif
        }
        UpdateLayout();
    }
    GripForgeVirtualStick MakeStick(string name, bool rightSide) {
        var go = new GameObject(name,typeof(RectTransform),typeof(Image),typeof(GripForgeVirtualStick));
        var r = (RectTransform)go.transform; r.SetParent(safe,false);
        r.anchorMin = r.anchorMax = new Vector2(rightSide ? 1 : 0,0);
        r.pivot = new Vector2(.5f,.5f);
        var image = go.GetComponent<Image>(); image.sprite = circle; image.color = new Color(.06f,.08f,.11f,.72f);
        var thumb = new GameObject("Thumb",typeof(RectTransform),typeof(Image));
        var tr = (RectTransform)thumb.transform; tr.SetParent(r,false);
        tr.anchorMin = tr.anchorMax = tr.pivot = new Vector2(.5f,.5f);
        var ti = thumb.GetComponent<Image>(); ti.sprite = circle; ti.raycastTarget = false;
        ColorUtility.TryParseHtmlString("${c.accent}",out Color accent); ti.color = accent;
        var stick = go.GetComponent<GripForgeVirtualStick>(); stick.Thumb = tr; stick.Deadzone = Deadzone;
        return stick;
    }
    void Update() {
        if (lastSafe != Screen.safeArea || lastScreen != new Vector2Int(Screen.width,Screen.height)) UpdateLayout();
    }
    void UpdateLayout() {
        if (!safe || Screen.width <= 0 || Screen.height <= 0) return;
        lastSafe = Screen.safeArea; lastScreen = new Vector2Int(Screen.width,Screen.height);
        safe.anchorMin = new Vector2(lastSafe.xMin/Screen.width,lastSafe.yMin/Screen.height);
        safe.anchorMax = new Vector2(lastSafe.xMax/Screen.width,lastSafe.yMax/Screen.height);
        safe.offsetMin = safe.offsetMax = Vector2.zero;
        Canvas.ForceUpdateCanvases();
        float radius = Mathf.Min(Radius, Mathf.Max(24,(safe.rect.width-72)/(Dual?4:2)));
        Layout(left,false,radius); if(right) Layout(right,true,radius);
    }
    void Layout(GripForgeVirtualStick stick, bool rightSide, float radius) {
        var r = (RectTransform)stick.transform;
        r.sizeDelta = Vector2.one * radius * 2;
        r.anchoredPosition = new Vector2((rightSide?-1:1)*(24+radius),24+radius);
        stick.Thumb.sizeDelta = Vector2.one * radius * .56f;
        stick.ResetStick();
    }
    void OnEnable() { if(ui) ui.SetActive(true); }
    void OnDisable() { if(ui) ui.SetActive(false); }
    void OnDestroy() {
        if(ui) Destroy(ui); if(circle) Destroy(circle); if(circleTexture) Destroy(circleTexture);
    }
}
}
`},{path:dir+'GripForgeJoystickMotorExample.cs',content:`using UnityEngine;
namespace GripForge.Inputs {
// Optional example. Prefer reading Joystick.Move in the motor already in your game.
[RequireComponent(typeof(CharacterController))]
public sealed class GripForgeJoystickMotorExample : MonoBehaviour {
    public GripForgeJoystickRig Joystick;
    public Transform View;
    public float Speed = 5, Gravity = -20;
    CharacterController motor;
    float vertical;
    void Awake() { motor = GetComponent<CharacterController>(); }
    void Update() {
        Vector2 axes = Joystick ? Joystick.Move : Vector2.zero;
        float yaw = View ? View.eulerAngles.y : transform.eulerAngles.y;
        Vector3 velocity = Quaternion.Euler(0,yaw,0) * new Vector3(axes.x,0,axes.y) * Speed;
        if (motor.isGrounded && vertical < 0) vertical = -2;
        vertical += Gravity * Time.deltaTime; velocity.y = vertical;
        motor.Move(velocity * Time.deltaTime);
    }
}
}
`},{path:'README.md',content:`# GripForge joystick · Unity 2022.3 / Unity 6

Copy Assets/GripForge/Joystick into your project. Install Unity UI (com.unity.ugui)
if your project does not include it. Add GripForgeJoystickRig to a scene GameObject
and press Play. It creates the overlay and reuses your EventSystem, or creates one
with the enabled input backend (legacy or Input System). An existing EventSystem
must have a working UI input module; do not add a second one.

Read rig.Move and rig.Look each frame. X is right; Y is forward/up. Feed Move into
your existing movement controller; multiply Look by your angular speed and deltaTime.
The optional MotorExample requires the built-in Physics module and uses
CharacterController.Move and gravity. Assign the
rig and camera in the Inspector; do not run it alongside another movement motor.

The two sticks have independent pointer ownership and a radial deadzone. Axes
persist while held, reset when released, disabled, resized or focus is lost. The
UI respects the safe area. The component does not rewrite gamepad/Input Actions.
Disable/remove the rig to remove its controls. Mouse testing is supported.
`}];
}
