using System;
using System.Collections.Generic;
using System.Runtime.InteropServices.JavaScript;
using System.Text.Json;
using System.Text.Json.Serialization;

public class FlashCard
{
    public int Id { get; set; }
    public string Hanzi { get; set; } = string.Empty;
    public string Pinyin { get; set; } = string.Empty;
    public string English { get; set; } = string.Empty;
}

[JsonSerializable(typeof(FlashCard))]
internal partial class DeckJsonContext : JsonSerializerContext
{
}

public partial class DeckEngine
{
    private static readonly List<FlashCard> _deck = new()
    {
        new FlashCard { Id = 1, Hanzi = "你好", Pinyin = "nǐ hǎo", English = "Hello" },
        new FlashCard { Id = 2, Hanzi = "谢谢", Pinyin = "xiè xie", English = "Thank you" },
        new FlashCard { Id = 3, Hanzi = "再见", Pinyin = "zài jiàn", English = "Goodbye" },
        new FlashCard { Id = 4, Hanzi = "是", Pinyin = "shì", English = "To be / yes" },
        new FlashCard { Id = 5, Hanzi = "不", Pinyin = "bù", English = "No / not" },
        new FlashCard { Id = 6, Hanzi = "我", Pinyin = "wǒ", English = "I / me" },
        new FlashCard { Id = 7, Hanzi = "你", Pinyin = "nǐ", English = "You" },
        new FlashCard { Id = 8, Hanzi = "爱", Pinyin = "ài", English = "Love" },
        new FlashCard { Id = 9, Hanzi = "吃", Pinyin = "chī", English = "To eat" },
        new FlashCard { Id = 10, Hanzi = "水", Pinyin = "shuǐ", English = "Water" },
        new FlashCard { Id = 11, Hanzi = "猫", Pinyin = "māo", English = "Cat" },
        new FlashCard { Id = 12, Hanzi = "狗", Pinyin = "gǒu", English = "Dog" },
        new FlashCard { Id = 13, Hanzi = "朋友", Pinyin = "péng you", English = "Friend" },
        new FlashCard { Id = 14, Hanzi = "老师", Pinyin = "lǎo shī", English = "Teacher" },
        new FlashCard { Id = 15, Hanzi = "学生", Pinyin = "xué sheng", English = "Student" }
    };

    [JSExport]
    public static string GetCardJson(int index)
    {
        if (index < 0 || index >= _deck.Count)
        {
            throw new ArgumentOutOfRangeException(nameof(index));
        }
        return JsonSerializer.Serialize(_deck[index], DeckJsonContext.Default.FlashCard);
    }

    [JSExport]
    public static int GetDeckCount()
    {
        return _deck.Count;
    }

    [JSExport]
    public static void AddCard(string hanzi, string pinyin, string english)
    {
        int nextId = _deck.Count + 1;
        _deck.Add(new FlashCard
        {
            Id = nextId,
            Hanzi = hanzi,
            Pinyin = pinyin,
            English = english
        });
    }

    // Lets the client fully replace the in-session deck, e.g. when loading a saved deck from the server
    [JSExport]
    public static void ClearDeck()
    {
        _deck.Clear();
    }
}